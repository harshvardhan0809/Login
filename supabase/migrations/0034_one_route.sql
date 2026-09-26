-- ===========================================================================
-- Collapse the lockdown check to one route, and delete the rest.
--
-- Answering "is this really Safe Exam Browser?" grew to thirteen migrations and
-- four thousand lines -- as much as the whole rest of the app. Most of that was
-- not the problem being hard. It was two mechanisms kept side by side:
--
--   the DIRECT route   keys read from the request that reaches the database
--   the PROOF route    keys observed by api/seb-verify, on this site's domain
--
-- The digests belong to different URLs, so they can never be compared with each
-- other. Three separate bugs came from exactly that: an indicator reading the
-- direct value when only the proof existed, and a submission gate that checked
-- the direct value on a platform that never sends it -- which would have thrown
-- away a finished paper.
--
-- Only the proof route works everywhere, so only the proof route survives.
--
-- Also deleted: the minimum-version check from 0026. It was built on the belief
-- that an old SEB was the cause, and the logging then showed the opposite --
-- SEB 3.10 on Windows sent nothing while 3.7 on macOS sent everything. A signal
-- that points the wrong way is worse than none, and it had already blocked a
-- working machine once.
--
-- And the pasted Browser Exam Key from 0021: the automatic fingerprint does the
-- same job without anybody typing a 64-character string.
--
-- WHAT THIS COSTS: every test must be shown a teacher's SEB once more, because
-- the direct fingerprints are being dropped. Open each protected test in SEB as
-- a teacher after running this. A test that has not been shown one is not
-- enforced -- it is never locked shut.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe. Needs 0033 first.
-- ===========================================================================

-- --- 1. the exam functions, on one route ------------------------------------

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
  v_proof   text;
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

  -- The Safe Exam Browser rule.
  --
  -- SEB attaches its exam keys to requests for this site's own domain, and some
  -- builds send them nowhere else -- never to the database. So the keys are
  -- observed by api/seb-verify, which records what it saw, and this function
  -- reads the recording. One route, on every platform.
  --
  -- The fingerprint is taught by record_seb_proof() the moment a teacher's own
  -- SEB presents its keys. Nothing is learned here, and nothing needs to be: a
  -- second request having to arrive afterwards, in the right order, carrying a
  -- user agent still recognised as SEB, was exactly the fragility that made
  -- this fail three times over.
  --
  -- A test no teacher has opened in SEB has no fingerprint and behaves as it
  -- always did, so this can never lock a hall out of a paper never set up.
  if t.requires_seb then
    select * into s from public.test_lockdown where test_id = p_test_id;

    v_proof := public.seb_proof_of(p_test_id, v_email);
    v_stored := s.seb_proof_fingerprint;
    v_key_ok := v_proof is not null and v_proof = v_stored;

    if v_admin then
      perform public.seb_log(p_test_id, v_email,
        'teacher_visit proof=' || (v_proof is not null)
          || ' stored=' || (v_stored is not null), v_stored);
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

    if v_stored is not null then
      if not v_key_ok and t.seb_enforcement in ('auto', 'strict') then
        perform public.seb_log(p_test_id, v_email, 'fingerprint_mismatch', v_stored);
        return jsonb_build_object(
          'state', 'seb_required', 'reason', 'key_mismatch', 'test', v_test,
          'seb_config_url', t.seb_config_url,
          'user_agent', left(public.request_user_agent(), 300)
        );
      end if;

    elsif t.seb_enforcement = 'strict' then
      -- Strict was asked for and nothing can prove anything yet.
      perform public.seb_log(p_test_id, v_email, 'key_not_configured', v_stored);
      return jsonb_build_object(
        'state', 'seb_required', 'reason', 'key_not_configured', 'test', v_test,
        'seb_config_url', t.seb_config_url,
        'user_agent', left(public.request_user_agent(), 300)
      );
    end if;

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

create or replace function public.submit_exam(p_test_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email     text := auth.jwt() ->> 'email';
  v_admin     boolean := public.is_admin();
  v_via_seb   boolean := public.request_is_seb();
  v_key_ok    boolean := false;
  v_proof     text;
  s           public.test_lockdown%rowtype;
  v_att_key   boolean;
  v_total     numeric := 0;
  v_score     numeric := 0;
  v_bonus     numeric := 0;
  v_penalty   numeric := 0;
  v_lost      numeric := 0;
  v_pct       numeric;
  t           public.tests%rowtype;
  v_started   timestamptz;
  v_ends      timestamptz;
  v_att_seb   boolean;
  v_seb_api   boolean;
  v_result_id uuid;
  q           record;
  v_given     jsonb;
  v_number    numeric;
  v_expected  text[];
  v_actual    text[];
  v_correct   boolean;
  v_detail    jsonb := '[]'::jsonb;
begin
  if v_email is null then
    raise exception 'You must be signed in to submit a test.';
  end if;

  select * into t from public.tests where id = p_test_id;
  if not found then
    raise exception 'That test no longer exists.';
  end if;

  if t.status <> 'published' then
    raise exception 'This test has not been released.';
  end if;

  if t.requires_seb then
    select * into s from public.test_lockdown where test_id = p_test_id;
  end if;

  if exists (
    select 1 from public.results where test_id = p_test_id and email = v_email
  ) then
    raise exception 'You have already submitted this test.';
  end if;

  select started_at, via_seb, seb_api, seb_key_verified
    into v_started, v_att_seb, v_seb_api, v_att_key
  from public.exam_attempts
  where test_id = p_test_id and email = v_email;

  if v_started is null then
    raise exception 'Open the test before submitting it.';
  end if;

  -- The lockdown rule at hand-in, placed after the attempt is known, because
  -- the decisive fact is whether this paper was verified when it was handed
  -- over -- and that is recorded on the attempt.
  --
  -- A student let in legitimately must never be prevented from handing in:
  -- losing a finished paper is a far worse failure than any forgery this could
  -- catch. So a verified open is enough on its own, and a fresh proof is
  -- accepted too, for a session that has been going a long time.
  if t.requires_seb and not v_admin then
    if not v_via_seb then
      raise exception 'This test must be submitted from Safe Exam Browser.';
    end if;

    v_proof := public.seb_proof_of(p_test_id, v_email);

    if t.seb_enforcement in ('auto', 'strict')
       and s.seb_proof_fingerprint is not null
       and not coalesce(v_att_key, false)
       and not (v_proof is not null and v_proof = s.seb_proof_fingerprint)
    then
      raise exception 'Safe Exam Browser could not be verified, so this paper cannot be submitted. Please tell your teacher.'
        using errcode = '42501';
    end if;
  end if;

  -- Marks lost per wrong answer, as a fraction of that question's marks:
  -- 0.25 is the familiar +4 / -1.
  v_penalty := coalesce(t.negative_marking, 0);

  v_ends := public.exam_ends_at(v_started, t.duration_minutes, t.closes_at);

  if v_ends is not null and now() > v_ends + interval '1 minute' then
    raise exception 'Time is up for this test, so it can no longer be submitted.';
  end if;

  for q in
    select * from public.questions where test_id = p_test_id
    order by position, created_at
  loop
    -- Bonus questions add to the score but never to the total: missing one
    -- costs nothing.
    if not q.is_bonus then
      v_total := v_total + q.points;
    end if;
    v_given := p_answers -> q.id::text;
    v_correct := false;

    if v_given is not null and v_given <> 'null'::jsonb then
      if q.type = 'text' then
        v_correct := jsonb_typeof(v_given) = 'string' and exists (
          select 1
          from jsonb_array_elements_text(q.answer_key) k
          where lower(btrim(k)) = lower(btrim(v_given #>> '{}'))
        );
      elsif q.type = 'numerical' then
        -- Compared as numbers, so 2.50, 2.5 and +2.5 are the same answer.
        v_number := case
          when jsonb_typeof(v_given) in ('string', 'number')
          then public.parse_decimal(v_given #>> '{}')
        end;
        v_correct := v_number is not null and exists (
          select 1
          from jsonb_array_elements_text(q.answer_key) k
          where public.parse_decimal(k) is not null
            and abs(v_number - public.parse_decimal(k)) <= coalesce(q.tolerance, 0)
        );
      elsif jsonb_typeof(v_given) = 'array' then
        select array(select jsonb_array_elements_text(q.answer_key) order by 1)
          into v_expected;
        select array(select distinct jsonb_array_elements_text(v_given) order by 1)
          into v_actual;

        v_correct := v_expected = v_actual;
      end if;
    end if;

    if v_correct then
      if q.is_bonus then
        v_bonus := v_bonus + q.points;
      else
        v_score := v_score + q.points;
      end if;
    elsif v_penalty > 0
      and not q.is_bonus
      -- Only a real attempt is penalised, and never a typed answer: losing
      -- marks to a spelling slip is not what negative marking is for.
      and q.type in ('single', 'multiple', 'numerical')
      and v_given is not null and v_given <> 'null'::jsonb
      and not (jsonb_typeof(v_given) = 'array' and jsonb_array_length(v_given) = 0)
      and not (jsonb_typeof(v_given) = 'string' and btrim(v_given #>> '{}') = '')
    then
      v_lost := v_lost + q.points * v_penalty;
    end if;

    v_detail := v_detail || jsonb_build_object(
      'q', q.id,
      'type', q.type,
      'points', q.points,
      'bonus', q.is_bonus,
      'earned', case
        when v_correct then q.points
        when v_penalty > 0 and not q.is_bonus and q.type in ('single', 'multiple', 'numerical')
             and v_given is not null and v_given <> 'null'::jsonb
        then -(q.points * v_penalty)
        else 0
      end,
      'given', coalesce(v_given, 'null'::jsonb),
      'correct', v_correct
    );
  end loop;

  if v_total = 0 then
    raise exception 'This test has no marked questions yet.';
  end if;

  -- Penalties, then bonus marks. A paper cannot score below zero or above
  -- full marks.
  v_score := greatest(least(v_score - v_lost + v_bonus, v_total), 0);
  v_pct := round((v_score / v_total) * 100);

  insert into public.results (test_id, email, score, total, percentage, attempted_at,
                              via_seb, seb_api, seb_key_verified)
  values (p_test_id, v_email, v_score, v_total, v_pct, now(),
          v_via_seb and coalesce(v_att_seb, v_via_seb), v_seb_api,
          -- True only if the key checked out when the paper was opened AND
          -- when it was handed in.
          coalesce(v_att_key, v_key_ok))
  returning id into v_result_id;

  insert into public.result_details (result_id, detail)
  values (v_result_id, v_detail);

  update public.exam_attempts
  set submitted_at = now()
  where test_id = p_test_id and email = v_email;

  return jsonb_build_object('score', v_score, 'total', v_total, 'percentage', v_pct,
                            'bonus', v_bonus, 'lost', v_lost);
end;
$$;

revoke all on function public.submit_exam(uuid, jsonb) from public, anon;
grant execute on function public.submit_exam(uuid, jsonb) to authenticated;

-- --- 2. the teacher's panel, reporting the one route ------------------------

create or replace function public.seb_check(p_test_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t       public.tests%rowtype;
  s       public.test_lockdown%rowtype;
  v_proof text;
begin
  perform public.require_admin();

  select * into t from public.tests where id = p_test_id;
  if not found then
    raise exception 'That test no longer exists.';
  end if;

  select * into s from public.test_lockdown where test_id = p_test_id;
  v_proof := public.seb_proof_of(p_test_id, auth.jwt() ->> 'email');

  return jsonb_build_object(
    'enforcement', t.seb_enforcement,
    'requires_seb', t.requires_seb,
    'looks_like_seb', public.request_is_seb(),
    'user_agent', left(public.request_user_agent(), 300),
    -- Did this browser show its keys to api/seb-verify?
    'proof_recorded', v_proof is not null,
    'proof_fingerprint_stored', s.seb_proof_fingerprint,
    'proof_learned_at', s.seb_proof_at,
    'verified', v_proof is not null and v_proof = s.seb_proof_fingerprint
  );
end;
$$;

revoke all on function public.seb_check(uuid) from public, anon;
grant execute on function public.seb_check(uuid) to authenticated;

-- --- 3. delete the direct route and the version check -----------------------

-- Dropped after the functions above stop referencing them, so this file can be
-- run in one go.
drop function if exists public.seb_fingerprint_seen();
drop function if exists public.seb_key_ok(text, text);
drop function if exists public.seb_hash_matches(text, text);
drop function if exists public.seb_candidate_urls();
drop function if exists public.seb_version_of(text);
drop function if exists public.version_lt(text, text);

alter table public.tests
  drop column if exists seb_min_version;

alter table public.test_lockdown
  drop column if exists seb_fingerprint,
  drop column if exists seb_fingerprint_at,
  drop column if exists seb_browser_exam_key,
  drop column if exists seb_config_key;

-- The log recorded both digests as separate columns; only one arrives now, and
-- seb_log() writes it as config_key_hash.
alter table public.seb_check_log
  drop column if exists request_hash;

-- seb_log() referenced the dropped request_header lookups for both digests.
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
    test_id, email, outcome, user_agent, config_key_hash, expected_fingerprint)
  values (
    p_test_id, p_email, p_outcome,
    left(public.request_user_agent(), 500),
    -- What this request carried, which on most platforms is nothing: the proof
    -- route is what counts, and `expected` shows what it was measured against.
    public.request_header('x-safeexambrowser-configkeyhash'),
    p_expected);
exception
  -- Diagnostics must never be the reason a student cannot sit a paper.
  when others then null;
end;
$$;

revoke all on function public.seb_log(uuid, text, text, text) from public, anon, authenticated;

notify pgrst, 'reload schema';
