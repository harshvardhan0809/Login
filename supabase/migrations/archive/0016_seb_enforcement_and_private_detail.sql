-- ===========================================================================
-- Enforcing Safe Exam Browser, and keeping per-question marks from students.
--
-- 1. Safe Exam Browser was a suggestion, not a rule. requires_seb only decided
--    which button the dashboard drew; get_exam() handed the paper to any
--    browser. A student could paste exam.html?test=<id> into Chrome and sit a
--    "protected" test with no lockdown, and nothing recorded that they had.
--
--    get_exam() and submit_exam() now refuse a protected test unless the
--    request comes from Safe Exam Browser, which marks its user agent with
--    "SEB/<version>". Teachers are exempt, so a published test can still be
--    checked from an ordinary browser.
--
--    Be clear about what that buys: it stops copy-and-paste, not someone who
--    fakes the header. So each attempt also records what was seen -- the
--    header verdict, whether the exam page found SEB's own JavaScript API, and
--    the raw user agent -- and teachers get a flag on any result that does not
--    add up. A faked header passes the first check but not the second.
--
-- 2. results.detail recorded which answers were correct, and every student
--    could read it for their own result. On a single-choice question a correct
--    entry IS the answer, so a student who finished early could pass the key
--    to one who had not started. Detail moves to result_details, which only
--    teachers can read.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- --- who is asking ---------------------------------------------------------

-- PostgREST exposes the incoming HTTP headers to SQL as JSON, with lower-cased
-- names. The browser sets User-Agent itself; page JavaScript cannot change it.
create or replace function public.request_user_agent()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.headers', true), '')::json ->> 'user-agent',
    ''
  );
$$;

-- Mirrors isRunningInSeb() in src/lib/seb.js exactly. If the two ever drift,
-- the page and the database disagree about whether the student is in SEB.
create or replace function public.request_is_seb()
returns boolean
language sql
stable
as $$
  select public.request_user_agent() ~* '\mSEB[[:space:]/]'
      or public.request_user_agent() ~* 'safeexambrowser';
$$;

-- Internal helpers for the definer functions below, not API.
revoke all on function public.request_user_agent() from public, anon, authenticated;
revoke all on function public.request_is_seb() from public, anon, authenticated;

-- --- what each attempt looked like -----------------------------------------

alter table public.exam_attempts
  add column if not exists via_seb boolean,
  add column if not exists seb_api boolean,
  add column if not exists user_agent text;

-- NULL on both means "not recorded": manual marks, and anything from before
-- this migration. The UI never flags a NULL -- absence of evidence is not an
-- accusation.
alter table public.results
  add column if not exists via_seb boolean,
  add column if not exists seb_api boolean;

-- --- per-question detail, teachers only ------------------------------------

create table if not exists public.result_details (
  result_id uuid primary key references public.results (id) on delete cascade,
  detail jsonb not null default '[]'::jsonb
);

alter table public.result_details enable row level security;

-- Written only by submit_exam(), which is SECURITY DEFINER. Nobody writes it
-- through the API, and students cannot read it at all.
revoke all on public.result_details from anon;
revoke insert, update, delete on public.result_details from authenticated;

drop policy if exists "result_details: admins read" on public.result_details;
create policy "result_details: admins read"
  on public.result_details for select to authenticated
  using (public.is_admin());

-- --- reading an exam -------------------------------------------------------

-- A new parameter means a new signature. Left in place, the old get_exam(uuid)
-- would be an ambiguous overload that PostgREST refuses to choose between.
drop function if exists public.get_exam(uuid);

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
    'requires_seb', t.requires_seb
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

  -- The same rule as get_exam(). Without it, a student who learned the
  -- question ids inside SEB could send their answers from anywhere.
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

  -- One minute of slack absorbs clock skew and the round trip of an
  -- auto-submit fired at zero. Beyond that the answers are genuinely late.
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

    -- Unanswered scores zero rather than erroring.
    if v_given is not null and v_given <> 'null'::jsonb then
      if q.type = 'text' then
        v_correct := jsonb_typeof(v_given) = 'string' and exists (
          select 1
          from jsonb_array_elements_text(q.answer_key) k
          where lower(btrim(k)) = lower(btrim(v_given #>> '{}'))
        );
      elsif jsonb_typeof(v_given) = 'array' then
        select array(select jsonb_array_elements_text(q.answer_key) order by 1)
          into v_expected;
        select array(select distinct jsonb_array_elements_text(v_given) order by 1)
          into v_actual;

        -- Exact set match: partial credit would need a per-option rule.
        v_correct := v_expected = v_actual;
      end if;
    end if;

    if v_correct then
      v_score := v_score + q.points;
    end if;

    -- `given` is kept so a teacher can see which wrong option pulled the
    -- class in, not merely that the question was missed.
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

  -- via_seb is true only if SEB both opened AND submitted the paper. An
  -- attempt from before this migration has no recorded opening, so the
  -- submission alone decides.
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

-- --- admin functions that used to touch results.detail ---------------------

create or replace function public.admin_set_result(
  p_test_id uuid,
  p_email   text,
  p_score   numeric,
  p_total   numeric,
  p_note    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_pct   numeric;
begin
  perform public.require_admin();

  if v_email = '' then
    raise exception 'A student email address is required.';
  end if;
  if p_total is null or p_total <= 0 then
    raise exception 'Total marks must be greater than zero.';
  end if;
  if p_score is null or p_score < 0 or p_score > p_total then
    raise exception 'The score must be between 0 and the total.';
  end if;
  if not exists (select 1 from public.tests where id = p_test_id) then
    raise exception 'That test no longer exists.';
  end if;

  v_pct := round((p_score / p_total) * 100);

  insert into public.results (
    test_id, email, score, total, percentage, attempted_at,
    adjusted_by, adjusted_at, adjustment_note
  )
  values (
    p_test_id, v_email, p_score, p_total, v_pct, now(),
    auth.jwt() ->> 'email', now(), nullif(btrim(coalesce(p_note, '')), '')
  )
  on conflict (test_id, email) do update set
    score           = excluded.score,
    total           = excluded.total,
    percentage      = excluded.percentage,
    adjusted_by     = excluded.adjusted_by,
    adjusted_at     = excluded.adjusted_at,
    adjustment_note = excluded.adjustment_note;
  -- attempted_at, via_seb and the row in result_details are deliberately left
  -- alone: they describe how the paper was actually sat, which an adjusted
  -- total does not change.

  return jsonb_build_object('email', v_email, 'score', p_score,
                            'total', p_total, 'percentage', v_pct);
end;
$$;

create or replace function public.admin_user_records(p_email text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := lower(btrim(p_email));
begin
  perform public.require_admin();

  return jsonb_build_object(
    'results', coalesce((
      select jsonb_agg(jsonb_build_object(
        'test_id', r.test_id,
        'title', t.title,
        'subject', t.subject,
        'requires_seb', t.requires_seb,
        'score', r.score,
        'total', r.total,
        'percentage', r.percentage,
        'attempted_at', r.attempted_at,
        'via_seb', r.via_seb,
        'seb_api', r.seb_api,
        'adjusted_by', r.adjusted_by,
        'adjusted_at', r.adjusted_at,
        'adjustment_note', r.adjustment_note
      ) order by r.attempted_at desc)
      from public.results r
      left join public.tests t on t.id = r.test_id
      where lower(r.email) = v_email
    ), '[]'::jsonb),

    -- An attempt with no matching result is someone who opened the paper and
    -- never submitted -- the exact case a teacher needs to find and reset.
    'attempts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'test_id', a.test_id,
        'title', t.title,
        'started_at', a.started_at,
        'submitted_at', a.submitted_at
      ) order by a.started_at desc)
      from public.exam_attempts a
      left join public.tests t on t.id = a.test_id
      where lower(a.email) = v_email
    ), '[]'::jsonb),

    'submissions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'assignment_id', s.assignment_id,
        'title', g.title,
        'link_url', s.link_url,
        'note', s.note,
        'submitted_at', s.submitted_at,
        'updated_at', s.updated_at
      ) order by s.updated_at desc)
      from public.assignment_submissions s
      left join public.assignments g on g.id = s.assignment_id
      where lower(s.email) = v_email
    ), '[]'::jsonb)
  );
end;
$$;

-- --- the security report learns about the new table ------------------------

create or replace function public.security_report()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_report jsonb;
begin
  -- The service role is allowed so this can be run from a setup script; it
  -- already bypasses every policy here anyway.
  if not (public.is_admin() or coalesce(auth.jwt() ->> 'role', '') = 'service_role') then
    raise exception 'Only a teacher can read the security report.' using errcode = '42501';
  end if;

  select jsonb_agg(row_to_json(x)::jsonb order by x.table_name)
    into v_report
  from (
    select
      c.relname as table_name,
      c.relrowsecurity as rls_enabled,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', pol.policyname,
          'command', pol.cmd,
          'roles', pol.roles,
          'using', pol.qual
        ) order by pol.policyname)
        from pg_policies pol
        where pol.schemaname = 'public' and pol.tablename = c.relname
      ), '[]'::jsonb) as policies,
      coalesce((
        select jsonb_agg(distinct g.privilege_type)
        from information_schema.role_table_grants g
        where g.table_schema = 'public'
          and g.table_name = c.relname
          and g.grantee = 'anon'
      ), '[]'::jsonb) as anon_grants
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname in (
        'users', 'tests', 'results', 'result_details', 'questions', 'videos',
        'notices', 'assignments', 'assignment_submissions', 'exam_attempts',
        'test_secrets', 'test_audience'
      )
  ) x;

  return coalesce(v_report, '[]'::jsonb);
end;
$$;

-- --- move existing detail, then remove the readable copy -------------------

-- Last, so every function above already writes to result_details before the
-- old column disappears. Guarded so a second run does nothing.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'results' and column_name = 'detail'
  ) then
    execute $q$
      insert into public.result_details (result_id, detail)
      select id, detail
      from public.results
      where jsonb_typeof(detail) = 'array' and jsonb_array_length(detail) > 0
      on conflict (result_id) do nothing
    $q$;

    execute 'alter table public.results drop column detail';
  end if;
end $$;

-- PostgREST caches function signatures; tell it get_exam changed shape.
notify pgrst, 'reload schema';
