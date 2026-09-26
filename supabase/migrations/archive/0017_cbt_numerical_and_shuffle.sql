-- ===========================================================================
-- 0017: numerical-value questions and per-test shuffling
--
-- Run after 0016. Safe to run more than once.
--
--   1. questions.type gains 'numerical': the student types a number and it is
--      compared numerically against the key, within questions.tolerance.
--   2. tests.shuffle_questions / tests.shuffle_options: when on, each student
--      gets their own order. The order is derived from the student's email,
--      so it is stable across reloads and different from their neighbour's.
--      Shuffling happens here, not in the browser, so the unshuffled order
--      never reaches a student.
--   3. submit_exam() grades numerical questions. Everything else about it is
--      unchanged from 0016.
-- ===========================================================================

-- --- numerical questions ---------------------------------------------------

alter table public.questions
  add column if not exists tolerance numeric not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.questions'::regclass
      and conname = 'questions_tolerance_check'
  ) then
    alter table public.questions
      add constraint questions_tolerance_check check (tolerance >= 0);
  end if;
end $$;

-- The type check from 0007 was unnamed, so find it by what it checks rather
-- than guessing the generated name.
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.questions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%type%'
      and pg_get_constraintdef(oid) ilike '%single%'
  loop
    execute format('alter table public.questions drop constraint %I', c.conname);
  end loop;

  alter table public.questions
    add constraint questions_type_check
    check (type in ('single', 'multiple', 'text', 'numerical'));
end $$;

-- Parses what a student typed into a number, or NULL if it is not one.
-- Deliberately narrow: optional sign, digits, one decimal point. No exponents,
-- no 'NaN' or 'Infinity' (which ::numeric would otherwise accept), no commas.
create or replace function public.parse_decimal(p_text text)
returns numeric
language sql
immutable
set search_path = public
as $$
  select case
    when length(btrim(p_text)) between 1 and 40
     and btrim(p_text) ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)$'
    then btrim(p_text)::numeric
  end;
$$;

revoke all on function public.parse_decimal(text) from public, anon, authenticated;

-- --- shuffling -------------------------------------------------------------

alter table public.tests
  add column if not exists shuffle_questions boolean not null default false,
  add column if not exists shuffle_options   boolean not null default false;

-- The paper as a student sees it: no answer keys, no tolerances, and in this
-- student's own order when the test asks for shuffling. Called only from
-- get_exam(), which runs as the owner.
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
        'points', q.points
      )
      order by
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

-- --- grading ---------------------------------------------------------------

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
    v_total := v_total + q.points;
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
      v_score := v_score + q.points;
    end if;

    v_detail := v_detail || jsonb_build_object(
      'q', q.id,
      'type', q.type,
      'points', q.points,
      'earned', case when v_correct then q.points else 0 end,
      'given', coalesce(v_given, 'null'::jsonb),
      'correct', v_correct
    );
  end loop;

  if v_total = 0 then
    raise exception 'This test has no questions yet.';
  end if;

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

  return jsonb_build_object('score', v_score, 'total', v_total, 'percentage', v_pct);
end;
$$;

revoke all on function public.submit_exam(uuid, jsonb) from public, anon;
grant execute on function public.submit_exam(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
