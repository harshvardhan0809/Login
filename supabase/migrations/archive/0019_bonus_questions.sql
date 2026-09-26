-- ===========================================================================
-- 0019: bonus questions
--
-- Run after 0018. Safe to run more than once.
--
-- A question can be marked as a bonus. Bonus questions:
--
--   - sit in their own section after the main paper;
--   - may be worth 0 marks (answered for practice or interest) or more;
--   - add what they earn to the score but nothing to the total, so skipping
--     or missing one never costs marks;
--   - cannot push a score past full marks: the score is capped at the total.
-- ===========================================================================

alter table public.questions
  add column if not exists is_bonus boolean not null default false;

-- Marks were required to be above zero. A bonus question may be worth zero;
-- a normal question still may not. The old check was unnamed, so it is found
-- by what it checks.
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.questions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%points%'
  loop
    execute format('alter table public.questions drop constraint %I', c.conname);
  end loop;

  alter table public.questions
    add constraint questions_points_check
    check (points >= 0 and (points > 0 or is_bonus));
end $$;

-- The paper as a student sees it, now with each question's bonus flag and the
-- bonus section last. Otherwise unchanged from 0017.
create or replace function public.exam_questions(p_test_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = public
as $$
declare
  v_seed          text := coalesce(lower(auth.jwt() ->> 'email'), '') || ':' || p_test_id::text;
  v_shuffle_q     boolean;
  v_shuffle_opts  boolean;
begin
  select shuffle_questions, shuffle_options
    into v_shuffle_q, v_shuffle_opts
  from public.tests where id = p_test_id;

  return coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'position', q.position,
        'prompt', q.prompt,
        'type', q.type,
        'options',
          case
            when coalesce(v_shuffle_opts, false)
             and q.type in ('single', 'multiple')
             and jsonb_typeof(q.options) = 'array'
            then (
              select coalesce(jsonb_agg(o order by md5(v_seed || ':' || coalesce(o ->> 'id', ''))), '[]'::jsonb)
              from jsonb_array_elements(q.options) o
            )
            else q.options
          end,
        'points', q.points,
        'bonus', q.is_bonus
      )
      order by
        -- Bonus questions are their own section, after the main paper. Any
        -- shuffling happens within each section, never across them.
        q.is_bonus,
        case when coalesce(v_shuffle_q, false) then md5(v_seed || ':' || q.id::text) end,
        q.position,
        q.created_at
    )
    from public.questions q
    where q.test_id = p_test_id
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.exam_questions(uuid) from public, anon, authenticated;

-- Grading, unchanged from 0017 except for how bonus questions count.
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
  v_total     numeric := 0;
  v_score     numeric := 0;
  v_bonus     numeric := 0;
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

  if t.requires_seb and not v_admin and not v_via_seb then
    raise exception 'This test must be submitted from Safe Exam Browser.';
  end if;

  if exists (
    select 1 from public.results where test_id = p_test_id and email = v_email
  ) then
    raise exception 'You have already submitted this test.';
  end if;

  select started_at, via_seb, seb_api
    into v_started, v_att_seb, v_seb_api
  from public.exam_attempts
  where test_id = p_test_id and email = v_email;

  if v_started is null then
    raise exception 'Open the test before submitting it.';
  end if;

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
    end if;

    v_detail := v_detail || jsonb_build_object(
      'q', q.id,
      'type', q.type,
      'points', q.points,
      'bonus', q.is_bonus,
      'earned', case when v_correct then q.points else 0 end,
      'given', coalesce(v_given, 'null'::jsonb),
      'correct', v_correct
    );
  end loop;

  if v_total = 0 then
    raise exception 'This test has no marked questions yet.';
  end if;

  -- Bonus marks can make up for marks lost elsewhere, but not push a score
  -- past full marks: 100% stays the ceiling.
  v_score := least(v_score + v_bonus, v_total);
  v_pct := round((v_score / v_total) * 100);

  insert into public.results (test_id, email, score, total, percentage, attempted_at, via_seb, seb_api)
  values (p_test_id, v_email, v_score, v_total, v_pct, now(),
          v_via_seb and coalesce(v_att_seb, v_via_seb), v_seb_api)
  returning id into v_result_id;

  insert into public.result_details (result_id, detail)
  values (v_result_id, v_detail);

  update public.exam_attempts
  set submitted_at = now()
  where test_id = p_test_id and email = v_email;

  return jsonb_build_object('score', v_score, 'total', v_total, 'percentage', v_pct,
                            'bonus', v_bonus);
end;
$$;

revoke all on function public.submit_exam(uuid, jsonb) from public, anon;
grant execute on function public.submit_exam(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
