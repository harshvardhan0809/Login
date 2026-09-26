-- ===========================================================================
-- SERIOUS FIX -- a Windows student could sit a paper and then not hand it in.
--
-- get_exam() learned about the proof route in 0028. submit_exam() did not. It
-- still asked only whether SEB keys were attached to THIS request:
--
--   and v_fp is null            -- always true on Windows
--   and not v_key_ok
--
-- Windows SEB attaches its keys to this site's own domain and never to the
-- database, so v_fp is null there by design. With a fingerprint stored, a
-- Windows student could therefore open the paper -- get_exam admits them
-- correctly via their proof -- work through it, and be refused at the one
-- moment that cannot be retried:
--
--   "Safe Exam Browser could not be verified, so this paper cannot be
--    submitted."
--
-- Three hours of work, gone. That is the worst failure this app could have,
-- and it was mine: I taught one half of the pair about the new route and left
-- the other behind.
--
-- Now any one of four proofs is enough to hand a paper in:
--
--   1. the attempt was verified when the paper was opened   <- the decisive one
--   2. SEB keys on this very request                        (macOS)
--   3. a recent proof shown to api/seb-verify               (Windows)
--   4. a pasted Browser Exam Key that checks out
--
-- The first is what makes this safe to relax: a student who was let in
-- legitimately must never be prevented from handing in. To use it the check
-- had to move below the point where the attempt is read, which is also a
-- better place for it -- "you already submitted" and "open it first" are now
-- answered before any talk of browsers.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe. Needs 0028 first.
-- ===========================================================================

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
  v_fp        text;
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

    v_fp := public.seb_fingerprint_seen();
    v_key_ok := public.seb_key_ok(s.seb_browser_exam_key, s.seb_config_key);
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

  -- The lockdown rule at hand-in. Deliberately placed AFTER the attempt is
  -- known, because the decisive fact is whether this paper was verified when it
  -- was handed over -- and that is recorded on the attempt.
  --
  -- Windows SEB attaches its keys only to this site's own domain, never to the
  -- database, so v_fp is always null there. Judging on v_fp alone meant a
  -- Windows student could open a paper, sit it for three hours, and then be
  -- refused at the moment of submission. Losing a finished paper is a far worse
  -- failure than any forgery this could catch, so any one of four proofs will do.
  if t.requires_seb and not v_admin then
    if not v_via_seb then
      raise exception 'This test must be submitted from Safe Exam Browser.';
    end if;

    if t.seb_enforcement in ('auto', 'strict')
       and (s.seb_fingerprint is not null
            or s.seb_proof_fingerprint is not null
            or coalesce(nullif(s.seb_browser_exam_key, ''),
                        nullif(s.seb_config_key, '')) is not null)
       -- verified when the paper was opened ...
       and not coalesce(v_att_key, false)
       -- ... or keys on this very request ...
       and v_fp is null
       -- ... or shown to api/seb-verify recently ...
       and public.seb_proof_of(p_test_id, v_email) is null
       -- ... or a pasted key that checks out.
       and not v_key_ok
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

notify pgrst, 'reload schema';
