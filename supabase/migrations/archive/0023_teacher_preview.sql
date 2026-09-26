-- ===========================================================================
-- A teacher's look at a paper stops counting as an attempt.
--
-- Until now an admin opening a PUBLISHED test went down the same path as a
-- candidate: an attempt row was created, a clock started, and submitting wrote
-- a real row into results -- under the teacher's own email, in the class
-- averages. Only drafts were previewed safely.
--
-- That became a problem with 0022. Teaching a test its SEB fingerprint means a
-- teacher opening the published paper inside Safe Exam Browser, so the one
-- action that sets up verification was also the action that burned an attempt
-- and could leave a teacher's score in the mark list.
--
-- Now a teacher previewing a published test gets the same treatment a draft
-- already had: the questions, no clock, no attempt row, nothing recorded. The
-- fingerprint is still learned, because that happens before this point.
--
-- The deadline, the start time and "already submitted" also stop applying to a
-- teacher, so a paper can be checked before it opens or after it closes.
--
-- What this gives up: a teacher can no longer sit their own test end to end as
-- a dry run. Use a spare student account for that -- which is the only way to
-- see what a student really sees in any case.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe. Needs 0022 first.
-- ===========================================================================

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
    v_fp := public.seb_fingerprint_seen();
    v_stored := t.seb_fingerprint;
    v_key_ok := public.seb_key_ok(t.seb_browser_exam_key, t.seb_config_key);

    -- Re-learned on every teacher visit, not just the first, so upgrading SEB
    -- or changing the config heals itself the next time a teacher looks.
    if v_admin and v_via_seb and v_fp is not null then
      update public.tests
         set seb_fingerprint = v_fp,
             seb_fingerprint_at = now(),
             seb_fingerprint_by = v_email
       where id = p_test_id;
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

    -- The strongest proof this test has to offer, in order: a key a teacher
    -- pasted, else the fingerprint learned from a teacher's own SEB.
    if coalesce(nullif(t.seb_browser_exam_key, ''),
                nullif(t.seb_config_key, '')) is not null then
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
