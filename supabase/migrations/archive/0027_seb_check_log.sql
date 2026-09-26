-- ===========================================================================
-- Make a failed Safe Exam Browser check leave evidence.
--
-- A student refused by the SEB gate never reaches the attempt insert, so they
-- leave no row anywhere. Two machines behaved differently and there was
-- nothing to read afterwards -- only guesses about versions and launch
-- methods. On exam morning that is the difference between a two-minute fix
-- and a hall full of students who cannot start.
--
-- So every verdict is now recorded: what the browser claimed, which
-- verification headers arrived (if any), and what was expected. Refusals and
-- passes alike, because a refusal only means something next to a pass.
--
-- Teachers only. The digests are not secrets -- they are what the browser
-- sends -- but they are exactly the value a student would need to replay, so
-- this table is admin-only like test_lockdown.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe. Needs 0026 first.
-- ===========================================================================

create table if not exists public.seb_check_log (
  id uuid primary key default gen_random_uuid(),
  test_id uuid references public.tests (id) on delete cascade,
  email text,
  at timestamptz not null default now(),
  -- verified | not_seb | outdated | key_mismatch | fingerprint_mismatch |
  -- key_not_configured
  outcome text not null,
  seb_version text,
  user_agent text,
  config_key_hash text,
  request_hash text,
  expected_fingerprint text
);

create index if not exists seb_check_log_test_idx
  on public.seb_check_log (test_id, at desc);

alter table public.seb_check_log enable row level security;

revoke all on public.seb_check_log from anon;
revoke insert, update, delete on public.seb_check_log from authenticated;

drop policy if exists "seb_check_log: admins read" on public.seb_check_log;
create policy "seb_check_log: admins read"
  on public.seb_check_log for select to authenticated
  using (public.is_admin());

-- Written only from inside get_exam(), which runs as the table's owner and so
-- is not subject to the revoke above. Students cannot write their own entries.
create or replace function public.seb_log(
  p_test_id uuid,
  p_email text,
  p_outcome text,
  p_expected text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.seb_check_log (
    test_id, email, outcome, seb_version, user_agent,
    config_key_hash, request_hash, expected_fingerprint)
  values (
    p_test_id, p_email, p_outcome,
    public.seb_version_of(public.request_user_agent()),
    left(public.request_user_agent(), 500),
    public.request_header('x-safeexambrowser-configkeyhash'),
    public.request_header('x-safeexambrowser-requesthash'),
    p_expected);
exception
  -- Diagnostics must never be the reason a student cannot sit a paper.
  when others then null;
end;
$$;

revoke all on function public.seb_log(uuid, text, text, text) from public, anon, authenticated;

-- --- get_exam, now recording every verdict ----------------------------------

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
      perform public.seb_log(p_test_id, v_email, 'not_seb', v_stored);
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
      perform public.seb_log(p_test_id, v_email, 'outdated', v_stored);
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
        perform public.seb_log(p_test_id, v_email, 'key_mismatch', v_stored);
        return jsonb_build_object(
          'state', 'seb_required', 'reason', 'key_mismatch', 'test', v_test,
          'seb_config_url', t.seb_config_url,
          'user_agent', left(public.request_user_agent(), 300)
        );
      end if;

    elsif v_stored is not null then
      if t.seb_enforcement in ('auto', 'strict')
         and coalesce(v_fp, '') <> v_stored then
        perform public.seb_log(p_test_id, v_email, 'fingerprint_mismatch', v_stored);
        return jsonb_build_object(
          'state', 'seb_required', 'reason', 'key_mismatch', 'test', v_test,
          'seb_config_url', t.seb_config_url,
          'user_agent', left(public.request_user_agent(), 300)
        );
      end if;
      v_key_ok := coalesce(v_fp, '') = v_stored;

    elsif t.seb_enforcement = 'strict' then
      -- Strict was asked for and nothing can prove anything yet.
      perform public.seb_log(p_test_id, v_email, 'key_not_configured', v_stored);
      return jsonb_build_object(
        'state', 'seb_required', 'reason', 'key_not_configured', 'test', v_test,
        'seb_config_url', t.seb_config_url,
        'user_agent', left(public.request_user_agent(), 300)
      );
    end if;
  end if;

  if t.requires_seb and not v_admin then
    perform public.seb_log(p_test_id, v_email, 'verified', v_stored);
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
