-- ===========================================================================
-- SEB enforcement that cannot be forged.
--
-- The problem this fixes: until now "is this Safe Exam Browser?" was answered
-- by reading the user agent -- a line of text the browser sends about itself.
-- Anyone can change it. Setting a custom user agent containing "SEB/3.5" in
-- Chrome's dev tools was enough to open a locked-down paper in an ordinary
-- browser, with notes and search open in the next tab, and the attempt was
-- recorded as via_seb = true. The audit trail actively vouched for the cheat.
--
-- The fix: SEB can prove itself. When sendBrowserExamKey is on (our generated
-- configs set it), SEB takes the URL of every request, appends its Browser
-- Exam Key, hashes the pair with SHA-256 and sends the digest as the header
-- X-SafeExamBrowser-RequestHash. The key itself never travels. A browser that
-- does not hold the key cannot produce the digest, so lying about the user
-- agent no longer gets anybody in.
--
-- Rolled out in two stages, because a check that wrongly rejects a real SEB
-- would lock a whole hall out of a live paper:
--
--   watch  (the default, and what every existing test gets)
--          Behaves exactly as before. The verdict is recorded but never
--          enforced, so you can confirm your own SEB passes.
--   strict Opening and submitting both require a valid key.
--
-- To switch a test over:
--   1. Open Safe Exam Browser -> Preferences -> Exam, and copy the
--      "Browser Exam Key" (64 hex characters).
--   2. Paste it into the test's Browser Exam Key box in the admin page.
--   3. Launch that test in SEB as a teacher. The page shows an SEB
--      verification panel; it must say the key was verified.
--   4. Set that test's enforcement to Strict.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe. Needs 0016 and 0020 first.
-- ===========================================================================

-- --- 1. what a test knows about its own lockdown ----------------------------

alter table public.tests
  -- seb_browser_exam_key already exists (0005) and was never used until now.
  add column if not exists seb_config_key text,
  add column if not exists seb_enforcement text not null default 'watch';

alter table public.tests drop constraint if exists tests_seb_enforcement_check;
alter table public.tests
  add constraint tests_seb_enforcement_check
  check (seb_enforcement in ('watch', 'strict'));

-- Kept per attempt and per result so a teacher can tell, after the fact,
-- which papers were cryptographically verified rather than merely claimed.
alter table public.exam_attempts add column if not exists seb_key_verified boolean;
alter table public.results       add column if not exists seb_key_verified boolean;

-- --- 2. reading the request -------------------------------------------------

-- PostgREST exposes the incoming headers as JSON, with names lower-cased.
create or replace function public.request_header(p_name text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(current_setting('request.headers', true), '')::json ->> lower(p_name);
$$;

-- The URL SEB hashed is the one it actually requested -- this RPC endpoint.
-- The database sees the pieces rather than the whole, and a proxy may present
-- the host under either name, so every plausible spelling is offered and any
-- one of them matching is enough. Comparing hashes means a wrong candidate
-- simply fails to match; there is no risk in trying several.
create or replace function public.seb_candidate_urls()
returns text[]
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_host  text := coalesce(public.request_header('x-forwarded-host'),
                           public.request_header('host'));
  v_proto text := coalesce(public.request_header('x-forwarded-proto'), 'https');
  v_path  text := coalesce(current_setting('request.path', true), '');
begin
  if v_host is null or v_path = '' then
    return '{}'::text[];
  end if;

  return array(
    select distinct u from unnest(array[
      v_proto || '://' || v_host || v_path,
      'https://' || v_host || v_path,
      'http://'  || v_host || v_path
    ]) u
  );
end;
$$;

-- SHA-256 is built into PostgreSQL 11 and later, so this needs no extension.
create or replace function public.seb_hash_matches(p_key text, p_header text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p_key, '') <> ''
     and coalesce(public.request_header(p_header), '') <> ''
     and exists (
       select 1
       from unnest(public.seb_candidate_urls()) u
       where encode(sha256(convert_to(u || p_key, 'utf8')), 'hex')
           = lower(public.request_header(p_header))
     );
$$;

-- True when this request carried proof of a genuine SEB holding one of the
-- test's keys. The Browser Exam Key identifies the SEB build plus its settings;
-- the Config Key identifies the settings alone. Either is proof enough.
create or replace function public.seb_key_ok(p_bek text, p_config_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.seb_hash_matches(p_bek, 'x-safeexambrowser-requesthash')
      or public.seb_hash_matches(p_config_key, 'x-safeexambrowser-configkeyhash');
$$;

revoke all on function public.request_header(text) from public, anon, authenticated;
revoke all on function public.seb_candidate_urls() from public, anon, authenticated;
revoke all on function public.seb_hash_matches(text, text) from public, anon, authenticated;
revoke all on function public.seb_key_ok(text, text) from public, anon, authenticated;

-- --- 3. the teacher's check -------------------------------------------------

-- Run this from inside Safe Exam Browser, as a teacher, before switching a
-- test to strict. It reports what the server actually received, so a key that
-- does not match can be diagnosed instead of guessed at.
create or replace function public.seb_check(p_test_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t      public.tests%rowtype;
  v_urls text[] := public.seb_candidate_urls();
begin
  perform public.require_admin();

  select * into t from public.tests where id = p_test_id;
  if not found then
    raise exception 'That test no longer exists.';
  end if;

  return jsonb_build_object(
    'enforcement', t.seb_enforcement,
    'requires_seb', t.requires_seb,
    'looks_like_seb', public.request_is_seb(),
    'user_agent', left(public.request_user_agent(), 300),
    'browser_exam_key_set', coalesce(t.seb_browser_exam_key, '') <> '',
    'config_key_set', coalesce(t.seb_config_key, '') <> '',
    'request_hash', public.request_header('x-safeexambrowser-requesthash'),
    'config_key_hash', public.request_header('x-safeexambrowser-configkeyhash'),
    'key_verified', public.seb_key_ok(t.seb_browser_exam_key, t.seb_config_key),
    -- Everything needed to work out a mismatch: the URLs considered, and what
    -- the header would have been for each had the stored key been used.
    'candidate_urls', to_jsonb(v_urls),
    'expected_request_hash', case
      when coalesce(t.seb_browser_exam_key, '') <> '' then to_jsonb(array(
        select encode(sha256(convert_to(u || t.seb_browser_exam_key, 'utf8')), 'hex')
        from unnest(v_urls) u))
    end,
    -- Any SEB header at all, in case a proxy renames or drops them.
    'seb_headers', coalesce((
      select jsonb_object_agg(h.k, h.v)
      from json_each_text(nullif(current_setting('request.headers', true), '')::json)
           as h(k, v)
      where h.k like '%safeexam%' or h.k like '%seb%'
    ), '{}'::jsonb)
  );
end;
$$;

revoke all on function public.seb_check(uuid) from public, anon;
grant execute on function public.seb_check(uuid) to authenticated;

-- --- 4. the exam functions, with the proof enforced -------------------------

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

  if exists (select 1 from public.results r
              where r.test_id = p_test_id and r.email = v_email) then
    return jsonb_build_object('state', 'already_attempted', 'test', v_test,
                              'already_attempted', true);
  end if;

  -- Checked before the deadline and before any attempt is created, so opening
  -- the page early cannot start a clock the student is not entitled to yet.
  if t.opens_at is not null and now() < t.opens_at then
    return jsonb_build_object('state', 'not_open_yet', 'test', v_test,
                              'opens_at', t.opens_at, 'server_time', now());
  end if;

  if t.closes_at is not null and now() > t.closes_at then
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
  --   2. Can it PROVE it? SEB hashes each request URL together with its Browser
  --      Exam Key and sends the result in a header. Only a real SEB holding the
  --      same key can produce that hash, and the key is never sent over the wire.
  --
  -- Under 'strict' the proof is required. Under 'watch' the verdict is merely
  -- recorded, so a school can confirm its own SEB passes before switching over
  -- and risking locking a hall full of students out of a live paper.
  if t.requires_seb then
    v_key_ok := public.seb_key_ok(t.seb_browser_exam_key, t.seb_config_key);
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

    if t.seb_enforcement = 'strict' and not v_key_ok then
      return jsonb_build_object(
        'state', 'seb_required',
        -- Told apart so an honest student in a genuine SEB is not left staring
        -- at "open this in SEB" while already sitting in it.
        'reason', case
          when coalesce(nullif(t.seb_browser_exam_key, ''),
                        nullif(t.seb_config_key, '')) is null
          then 'key_not_configured'
          else 'key_mismatch'
        end,
        'test', v_test,
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
    v_key_ok := public.seb_key_ok(t.seb_browser_exam_key, t.seb_config_key);
  end if;

  if t.requires_seb and not v_admin then
    if not v_via_seb then
      raise exception 'This test must be submitted from Safe Exam Browser.';
    end if;

    -- Checked again at submission, not just at opening: otherwise a student
    -- could open the paper in a verified SEB and post the answers from
    -- anywhere else.
    if t.seb_enforcement = 'strict' and not v_key_ok then
      raise exception 'Safe Exam Browser could not be verified, so this paper cannot be submitted. Please tell your teacher.'
        using errcode = '42501';
    end if;
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
          v_key_ok and coalesce(v_att_key, v_key_ok))
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

notify pgrst, 'reload schema';
