-- ===========================================================================
-- Exam delivery: draft/publish, deadlines, time limits, server-held clock.
--
-- Four things this adds:
--
--   1. A test is a DRAFT until a teacher publishes it. Students cannot see or
--      open a draft, so questions are always finished before release.
--   2. A test is either 'builtin' (questions in this portal, auto-graded) or
--      'link' (an existing Google Form or similar).
--   3. closes_at is the deadline; duration_minutes is the maximum time one
--      student gets once they open it. Both are enforced HERE, not in the
--      browser -- a student who reloads, or edits the page, cannot buy time.
--   4. quit passwords live in an admin-only table, never in public.tests,
--      which every signed-in student can read.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- --- delivery columns ------------------------------------------------------

alter table public.tests
  add column if not exists kind text not null default 'builtin',
  add column if not exists status text not null default 'draft',
  add column if not exists closes_at timestamptz,
  add column if not exists duration_minutes integer,
  add column if not exists published_at timestamptz;

do $$
begin
  alter table public.tests add constraint tests_kind_check
    check (kind in ('builtin', 'link'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.tests add constraint tests_status_check
    check (status in ('draft', 'published'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.tests add constraint tests_duration_check
    check (duration_minutes is null or (duration_minutes >= 1 and duration_minutes <= 600));
exception when duplicate_object then null;
end $$;

-- Tests that predate this migration keep working. A test that already has a
-- form link or questions was live, so it is published; anything else was
-- half-built and correctly becomes a draft.
update public.tests set kind = 'link'
where kind = 'builtin'
  and form_url is not null
  and not exists (select 1 from public.questions q where q.test_id = tests.id);

update public.tests set status = 'published', published_at = coalesce(published_at, now())
where status = 'draft'
  and (form_url is not null
       or exists (select 1 from public.questions q where q.test_id = tests.id));

-- --- students only ever see released tests ---------------------------------

drop policy if exists "tests: read for signed-in users" on public.tests;
drop policy if exists "tests: read published" on public.tests;
create policy "tests: read published"
  on public.tests for select to authenticated
  using (status = 'published' or public.is_admin());

-- --- quit passwords (admin-only) -------------------------------------------

-- Deliberately NOT a column on public.tests: that table is readable by every
-- signed-in student, and a student holding the quit password can walk out of
-- the locked-down browser mid-exam.
create table if not exists public.test_secrets (
  test_id uuid primary key references public.tests (id) on delete cascade,
  quit_password text not null,
  updated_at timestamptz not null default now()
);

alter table public.test_secrets enable row level security;

drop policy if exists "test_secrets: admins only" on public.test_secrets;
create policy "test_secrets: admins only"
  on public.test_secrets for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --- attempts: when each student's clock started ---------------------------

create table if not exists public.exam_attempts (
  test_id uuid not null references public.tests (id) on delete cascade,
  email text not null,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  primary key (test_id, email)
);

alter table public.exam_attempts enable row level security;

-- Written only by get_exam()/submit_exam(), which are SECURITY DEFINER. If a
-- student could insert or update this row they could reset their own timer.
revoke insert, update, delete on public.exam_attempts from anon, authenticated;

drop policy if exists "exam_attempts: read own or admin" on public.exam_attempts;
create policy "exam_attempts: read own or admin"
  on public.exam_attempts for select to authenticated
  using (email = auth.jwt() ->> 'email' or public.is_admin());

-- --- when does this student's exam end? ------------------------------------

-- The earlier of "started + duration" and the deadline. NULL means untimed.
-- least() ignores NULLs, so either limit alone works.
create or replace function public.exam_ends_at(
  p_started timestamptz,
  p_duration_minutes integer,
  p_closes_at timestamptz
)
returns timestamptz
language sql
immutable
as $$
  select least(
    case when p_duration_minutes is null then null
         else p_started + make_interval(mins => p_duration_minutes) end,
    p_closes_at
  );
$$;

-- --- reading an exam -------------------------------------------------------

-- Questions WITHOUT answer_key. Split out so get_exam has one place that
-- builds this projection, and no path can accidentally leak the key.
create or replace function public.exam_questions(p_test_id uuid)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'id', q.id,
        'position', q.position,
        'prompt', q.prompt,
        'type', q.type,
        'options', q.options,
        'points', q.points
      ) order by q.position, q.created_at
    )
    from public.questions q where q.test_id = p_test_id
  ), '[]'::jsonb);
$$;

create or replace function public.get_exam(p_test_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_admin   boolean := public.is_admin();
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

  if exists (select 1 from public.results r
              where r.test_id = p_test_id and r.email = v_email) then
    return jsonb_build_object('state', 'already_attempted', 'test', v_test,
                              'already_attempted', true);
  end if;

  if t.closes_at is not null and now() > t.closes_at then
    return jsonb_build_object('state', 'closed', 'test', v_test);
  end if;

  -- A link test is taken elsewhere; hand back the address, nothing more.
  if t.kind = 'link' then
    return jsonb_build_object('state', 'external', 'test', v_test,
                              'form_url', t.form_url, 'server_time', now());
  end if;

  -- Starts the clock on first open. ON CONFLICT DO NOTHING is what makes a
  -- reload harmless: the original started_at survives.
  insert into public.exam_attempts (test_id, email)
  values (p_test_id, v_email)
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

-- --- grading ---------------------------------------------------------------

create or replace function public.submit_exam(p_test_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := auth.jwt() ->> 'email';
  v_total    numeric := 0;
  v_score    numeric := 0;
  v_pct      numeric;
  t          public.tests%rowtype;
  v_started  timestamptz;
  v_ends     timestamptz;
  q          record;
  v_given    jsonb;
  v_expected text[];
  v_actual   text[];
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

  if exists (
    select 1 from public.results where test_id = p_test_id and email = v_email
  ) then
    raise exception 'You have already submitted this test.';
  end if;

  select started_at into v_started
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

  for q in select * from public.questions where test_id = p_test_id loop
    v_total := v_total + q.points;
    v_given := p_answers -> q.id::text;

    -- Unanswered scores zero rather than erroring.
    if v_given is null or v_given = 'null'::jsonb then
      continue;
    end if;

    if q.type = 'text' then
      if jsonb_typeof(v_given) = 'string' and exists (
        select 1
        from jsonb_array_elements_text(q.answer_key) k
        where lower(btrim(k)) = lower(btrim(v_given #>> '{}'))
      ) then
        v_score := v_score + q.points;
      end if;
    else
      if jsonb_typeof(v_given) = 'array' then
        select array(select jsonb_array_elements_text(q.answer_key) order by 1)
          into v_expected;
        select array(select distinct jsonb_array_elements_text(v_given) order by 1)
          into v_actual;

        -- Exact set match: partial credit would need a per-option rule.
        if v_expected = v_actual then
          v_score := v_score + q.points;
        end if;
      end if;
    end if;
  end loop;

  if v_total = 0 then
    raise exception 'This test has no questions yet.';
  end if;

  v_pct := round((v_score / v_total) * 100);

  insert into public.results (test_id, email, score, total, percentage, attempted_at)
  values (p_test_id, v_email, v_score, v_total, v_pct, now());

  update public.exam_attempts
  set submitted_at = now()
  where test_id = p_test_id and email = v_email;

  return jsonb_build_object('score', v_score, 'total', v_total, 'percentage', v_pct);
end;
$$;

revoke all on function public.get_exam(uuid) from public, anon;
revoke all on function public.submit_exam(uuid, jsonb) from public, anon;
grant execute on function public.get_exam(uuid) to authenticated;
grant execute on function public.submit_exam(uuid, jsonb) to authenticated;

-- exam_questions is an internal helper for get_exam, which calls it as the
-- function owner. `authenticated` must be revoked explicitly: Supabase grants
-- EXECUTE on new functions to that role by default, and a student calling it
-- directly would read the questions of a draft they cannot open yet.
revoke all on function public.exam_questions(uuid) from public, anon, authenticated;

-- --- carried forward from 0007 --------------------------------------------

-- Repeated here because it is the one thing in 0007 that must be in force:
-- without it a student can POST their own row into results and award
-- themselves full marks. Harmless to run twice.
drop policy if exists "results: insert own" on public.results;
revoke insert, update, delete on public.results from anon, authenticated;
