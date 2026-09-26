-- ===========================================================================
-- 0020: sections and negative marking
--
-- Run after 0019. Safe to run more than once.
--
--   1. questions.section: an optional label such as 'Physics'. Questions with
--      the same label sit together on the paper, in their own part of the
--      question palette. A section's place is where its first question sits.
--      Bonus questions stay last, whatever their section.
--
--   2. tests.negative_marking: marks lost for a wrong answer, as a fraction of
--      that question's marks. 0 (the default) keeps every existing test
--      exactly as it is; 0.25 is the familiar +4 / -1.
--
--      Nothing is lost for a question left blank, for a bonus question, or for
--      a typed short answer. A paper never scores below zero.
--
--   3. results.score and results.total become numeric. They were whole
--      numbers, so a half-mark question or a 0.75 penalty was silently
--      rounded.
-- ===========================================================================

alter table public.questions
  add column if not exists section text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.questions'::regclass and conname = 'questions_section_check'
  ) then
    alter table public.questions
      add constraint questions_section_check
      check (section is null or (length(btrim(section)) between 1 and 60));
  end if;
end $$;

create index if not exists questions_section_idx on public.questions (test_id, section);

alter table public.tests
  add column if not exists negative_marking numeric not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.tests'::regclass and conname = 'tests_negative_marking_check'
  ) then
    alter table public.tests
      add constraint tests_negative_marking_check
      check (negative_marking >= 0 and negative_marking <= 1);
  end if;
end $$;

-- Whole numbers could not hold a half mark or a 0.75 penalty.
alter table public.results
  alter column score type numeric,
  alter column total type numeric;

-- The paper as a student sees it, now carrying each question's section and
-- keeping sections together. Otherwise unchanged from 0019.
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

  -- A section's place in the paper is where its first question sits, so
  -- teachers order sections simply by the order they add questions in.
  return coalesce((
    with ranked as (
      select q.*, min(q.position) over (partition by q.is_bonus, coalesce(q.section, '')) as section_rank
      from public.questions q
      where q.test_id = p_test_id
    )
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
        'bonus', q.is_bonus,
        'section', q.section
      )
      order by
        -- Bonus questions are their own section, after the main paper, and
        -- sections keep their order. Any shuffling happens within a section,
        -- never across them.
        q.is_bonus,
        q.section_rank,
        case when coalesce(v_shuffle_q, false) then md5(v_seed || ':' || q.id::text) end,
        q.position,
        q.created_at
    )
    from ranked q
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.exam_questions(uuid) from public, anon, authenticated;

-- Unchanged from 0016 except that the test it returns now carries its
-- negative marking, which the exam page shows on each question.
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
  if t.requires_seb and not v_admin and not v_via_seb then
    return jsonb_build_object(
      'state', 'seb_required',
      'test', v_test,
      'seb_config_url', t.seb_config_url,
      -- Returned so a genuine SEB that is not being recognised can be
      -- diagnosed from a screenshot rather than guessed at.
      'user_agent', left(public.request_user_agent(), 300)
    );
  end if;

  -- A link test is taken elsewhere; hand back the address, nothing more.
  if t.kind = 'link' then
    return jsonb_build_object('state', 'external', 'test', v_test,
                              'form_url', t.form_url, 'server_time', now());
  end if;

  -- Starts the clock on first open. ON CONFLICT DO NOTHING is what makes a
  -- reload harmless: the original started_at -- and the original record of
  -- which browser opened it -- survive.
  insert into public.exam_attempts (test_id, email, via_seb, seb_api, user_agent)
  values (p_test_id, v_email, v_via_seb, p_seb_api, left(public.request_user_agent(), 500))
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

-- Grading, unchanged from 0019 except for penalties.
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
                            'bonus', v_bonus, 'lost', v_lost);
end;
$$;

revoke all on function public.submit_exam(uuid, jsonb) from public, anon;
grant execute on function public.submit_exam(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
