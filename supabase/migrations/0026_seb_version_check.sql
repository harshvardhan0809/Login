-- ===========================================================================
-- Catch an out-of-date Safe Exam Browser before exam morning.
--
-- Two machines, the same config, different behaviour: one sent its
-- verification headers and taught the test a fingerprint, the other sent none
-- and every student on it was refused with "Safe Exam Browser could not be
-- verified". A message nobody can act on, at the worst possible moment.
--
-- The usual cause is simply an older SEB. So a test may now state the version
-- it needs, and a machine below it is told exactly that, with the version it
-- has and where to get a current one -- while it is still Tuesday.
--
-- This is emphatically NOT a security control. The version comes from the
-- user agent, which the browser writes about itself and a student can edit in
-- a minute. It refuses honest machines that need updating; it stops nobody who
-- is trying. The fingerprint check does that job.
--
-- Two deliberate softenings, both from the same lesson:
--   * A user agent with no readable version is never refused. Absence of
--     evidence is not an old copy, and refusing on it would lock out anyone
--     whose SEB words its user agent differently.
--   * seb_min_version is null by default, so every existing test is unchanged
--     until a teacher sets one.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe. Needs 0025 first.
-- ===========================================================================

alter table public.tests
  add column if not exists seb_min_version text;

-- --- reading the version out of a user agent --------------------------------

-- Mirrors sebVersion() in src/lib/sebVersion.js. If the two ever drift, the
-- page and the database disagree about whether a machine needs updating.
create or replace function public.seb_version_of(p_ua text)
returns text
language sql
immutable
set search_path = public
as $$
  select coalesce(
    (regexp_match(p_ua, '\mSEB[[:space:]/]v?([0-9]+(\.[0-9]+)*)', 'i'))[1],
    (regexp_match(p_ua, 'SafeExamBrowser[[:space:]/]v?([0-9]+(\.[0-9]+)*)', 'i'))[1]
  );
$$;

-- Compared as numbers, component by component, so 3.10 is correctly newer
-- than 3.9 -- which comparing the strings gets backwards.
create or replace function public.version_lt(p_a text, p_b text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  a int[];
  b int[];
begin
  -- Anything unreadable is treated as "not older", never as a reason to refuse.
  if p_a is null or p_b is null then
    return false;
  end if;
  if p_a !~ '^[0-9]+(\.[0-9]+)*$' or p_b !~ '^[0-9]+(\.[0-9]+)*$' then
    return false;
  end if;

  a := (string_to_array(p_a, '.') || array['0', '0', '0'])[1:3]::int[];
  b := (string_to_array(p_b, '.') || array['0', '0', '0'])[1:3]::int[];

  return a < b;
end;
$$;

revoke all on function public.seb_version_of(text) from public, anon, authenticated;
revoke all on function public.version_lt(text, text) from public, anon, authenticated;

-- --- the exam function, checking the version first ---------------------------

create or replace function public.get_exam(p_test_id uuid, p_seb_api boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_admin   boolean := public.is_admin();
  v_via_seb boolean := public.request_is_seb();
  v_key_ok  boolean := false;
  v_fp      text;
  v_stored  text;
  s         public.test_lockdown%rowtype;
  t         public.tests%rowtype;
  v_started timestamptz;
  v_ends    timestamptz;
  v_test    jsonb;
begin
  if v_email is null then
    raise exception 'You must be signed in to open a test.';
  end if;

  select * into t from public.tests where id = p_test_id;
  if not found then
    return jsonb_build_object('state', 'not_found');
  end if;

  v_test := jsonb_build_object(
    'id', t.id,
    'title', t.title,
    'subject', t.subject,
    'kind', t.kind,
    'duration_minutes', t.duration_minutes,
    'opens_at', t.opens_at,
    'closes_at', t.closes_at,
    'requires_seb', t.requires_seb,
    -- So the paper can tell students what a wrong answer costs.
    'negative_marking', t.negative_marking
  );

  -- Drafts are invisible to students; an admin may preview one, and doing so
  -- must not start a clock or leave an attempt row behind.
  if t.status <> 'published' then
    if not v_admin then
      return jsonb_build_object('state', 'not_released', 'test', v_test);
    end if;
    return jsonb_build_object(
      'state', 'preview',
      'test', v_test,
      'server_time', now(),
      'questions', public.exam_questions(p_test_id)
    );
  end if;

  -- This function runs as its owner and so is not filtered by the policy on
  -- tests. A student with a direct link would otherwise walk straight past it.
  if t.audience = 'selected' and not v_admin and not exists (
    select 1 from public.test_audience a
    where a.test_id = p_test_id and lower(a.email) = lower(v_email)
  ) then
    return jsonb_build_object('state', 'not_assigned', 'test', v_test);
  end if;

  if not v_admin and exists (select 1 from public.results r
              where r.test_id = p_test_id and r.email = v_email) then
    return jsonb_build_object('state', 'already_attempted', 'test', v_test,
                              'already_attempted', true);
  end if;

  -- Checked before the deadline and before any attempt is created, so opening
  -- the page early cannot start a clock the student is not entitled to yet.
  if not v_admin and t.opens_at is not null and now() < t.opens_at then
    return jsonb_build_object('state', 'not_open_yet', 'test', v_test,
                              'opens_at', t.opens_at, 'server_time', now());
  end if;

  if not v_admin and t.closes_at is not null and now() > t.closes_at then
    return jsonb_build_object('state', 'closed', 'test', v_test);
  end if;

  -- The Safe Exam Browser rule. Placed after the informational states, so a
  -- student in the wrong browser still learns that a test is closed or already
  -- done, but before the paper is handed over and -- crucially -- before the
  -- attempt row exists, so opening the link in Chrome cannot start their clock.
  -- Two questions, not one.
  --
  --   1. Does the browser SAY it is Safe Exam Browser? That is the user agent,
  --      and a student can forge it in a minute from Chrome's dev tools.
  --   2. Can it PROVE it? SEB hashes each request URL together with its keys
  --      and sends the digests as headers. Faking the user agent sends none of
  --      them, and the keys themselves never travel.
  --
  -- Nothing here is typed in by a teacher. The first time a teacher opens the
  -- paper inside SEB, the digest their SEB sends is remembered as this test's
  -- fingerprint, and every student is then held to it. A test nobody has ever
  -- opened in SEB keeps the old behaviour exactly, so this can never lock a
  -- hall out of a paper that was never set up.
  if t.requires_seb then
    -- Kept in test_lockdown, not on tests: students may read their own test
    -- row, and a fingerprint they can read is a fingerprint they can replay.
    select * into s from public.test_lockdown where test_id = p_test_id;

    v_fp := public.seb_fingerprint_seen();
    v_stored := s.seb_fingerprint;
    v_key_ok := public.seb_key_ok(s.seb_browser_exam_key, s.seb_config_key);

    -- Re-learned on every teacher visit, not just the first, so upgrading SEB
    -- or changing the config heals itself the next time a teacher looks.
    if v_admin and v_via_seb and v_fp is not null then
      insert into public.test_lockdown (test_id, seb_fingerprint, seb_fingerprint_at, seb_fingerprint_by)
      values (p_test_id, v_fp, now(), v_email)
      on conflict (test_id) do update
        set seb_fingerprint = excluded.seb_fingerprint,
            seb_fingerprint_at = excluded.seb_fingerprint_at,
            seb_fingerprint_by = excluded.seb_fingerprint_by,
            updated_at = now();
      v_stored := v_fp;
    end if;
  end if;

  if t.requires_seb and not v_admin then
    if not v_via_seb then
      return jsonb_build_object(
        'state', 'seb_required',
        'reason', 'not_seb',
        'test', v_test,
        'seb_config_url', t.seb_config_url,
        -- Returned so a genuine SEB that is not being recognised can be
        -- diagnosed from a screenshot rather than guessed at.
        'user_agent', left(public.request_user_agent(), 300)
      );
    end if;

    -- An out-of-date Safe Exam Browser is the usual reason the proof headers
    -- never arrive. Checked before the fingerprint, so such a machine is told
    -- plainly to update rather than left with "could not be verified", which
    -- says nothing anyone can act on.
    --
    -- A user agent proves nothing -- a student can write whatever they like in
    -- it -- so this refuses honest machines that need updating, and is not a
    -- security control. An unreadable version is never refused.
    if t.seb_min_version is not null
       and public.version_lt(
             public.seb_version_of(public.request_user_agent()), t.seb_min_version)
    then
      return jsonb_build_object(
        'state', 'seb_outdated',
        'test', v_test,
        'found_version', public.seb_version_of(public.request_user_agent()),
        'required_version', t.seb_min_version,
        'seb_config_url', t.seb_config_url,
        'user_agent', left(public.request_user_agent(), 300)
      );
    end if;

    -- The strongest proof this test has to offer, in order: a key a teacher
    -- pasted, else the fingerprint learned from a teacher's own SEB.
    if coalesce(nullif(s.seb_browser_exam_key, ''),
                nullif(s.seb_config_key, '')) is not null then
      if not v_key_ok and t.seb_enforcement in ('auto', 'strict') then
        return jsonb_build_object(
          'state', 'seb_required', 'reason', 'key_mismatch', 'test', v_test,
          'seb_config_url', t.seb_config_url,
          'user_agent', left(public.request_user_agent(), 300)
        );
      end if;

    elsif v_stored is not null then
      if t.seb_enforcement in ('auto', 'strict')
         and coalesce(v_fp, '') <> v_stored then
        return jsonb_build_object(
          'state', 'seb_required', 'reason', 'key_mismatch', 'test', v_test,
          'seb_config_url', t.seb_config_url,
          'user_agent', left(public.request_user_agent(), 300)
        );
      end if;
      v_key_ok := coalesce(v_fp, '') = v_stored;

    elsif t.seb_enforcement = 'strict' then
      -- Strict was asked for and nothing can prove anything yet.
      return jsonb_build_object(
        'state', 'seb_required', 'reason', 'key_not_configured', 'test', v_test,
        'seb_config_url', t.seb_config_url,
        'user_agent', left(public.request_user_agent(), 300)
      );
    end if;
  end if;

  -- A link test is taken elsewhere; hand back the address, nothing more.
  if t.kind = 'link' then
    return jsonb_build_object('state', 'external', 'test', v_test,
                              'form_url', t.form_url, 'server_time', now());
  end if;

  -- A teacher opening a published paper is inspecting it, not sitting it.
  -- Returning here means no attempt row, no clock, and nothing that can reach
  -- the mark list -- which is what makes it safe to open a test purely to
  -- teach it what a genuine Safe Exam Browser looks like.
  --
  -- The fingerprint above has already been learned by this point, so the whole
  -- setup costs a teacher one look at the paper and nothing else.
  if v_admin then
    return jsonb_build_object(
      'state', 'preview',
      'test', v_test,
      'server_time', now(),
      'questions', public.exam_questions(p_test_id)
    );
  end if;

  -- Starts the clock on first open. ON CONFLICT DO NOTHING is what makes a
  -- reload harmless: the original started_at -- and the original record of
  -- which browser opened it -- survive.
  insert into public.exam_attempts (test_id, email, via_seb, seb_api, user_agent, seb_key_verified)
  values (p_test_id, v_email, v_via_seb, p_seb_api, left(public.request_user_agent(), 500), v_key_ok)
  on conflict (test_id, email) do nothing;

  select started_at into v_started
  from public.exam_attempts
  where test_id = p_test_id and email = v_email;

  v_ends := public.exam_ends_at(v_started, t.duration_minutes, t.closes_at);

  if v_ends is not null and now() > v_ends then
    return jsonb_build_object('state', 'time_up', 'test', v_test);
  end if;

  return jsonb_build_object(
    'state', 'open',
    'test', v_test,
    'already_attempted', false,
    -- The browser's own clock is not trusted: it anchors its countdown to
    -- these two values and measures elapsed time from there.
    'server_time', now(),
    'started_at', v_started,
    'ends_at', v_ends,
    'questions', public.exam_questions(p_test_id)
  );
end;
$$;

revoke all on function public.get_exam(uuid, boolean) from public, anon;
grant execute on function public.get_exam(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
