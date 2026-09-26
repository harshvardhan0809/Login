-- ===========================================================================
-- Choosing who a test is for.
--
-- Every test is for everybody unless a teacher says otherwise, so `audience`
-- defaults to 'all' and existing tests keep behaving exactly as they did.
-- Switching a test to 'selected' limits it to the addresses listed in
-- test_audience.
--
-- Enforced in two places, and it needs both:
--
--   1. The RLS policy on `tests`, so an unlisted student cannot even see the
--      row -- it never reaches their dashboard.
--   2. get_exam() and submit_exam(), which are SECURITY DEFINER and therefore
--      bypass RLS entirely. Without a check of their own, a student holding a
--      direct link could call get_exam() for a test they were never given.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

alter table public.tests
  add column if not exists audience text not null default 'all';

do $$
begin
  alter table public.tests add constraint tests_audience_check
    check (audience in ('all', 'selected'));
exception when duplicate_object then null;
end $$;

-- --- who a limited test is for ---------------------------------------------

create table if not exists public.test_audience (
  test_id uuid not null references public.tests (id) on delete cascade,
  email text not null,
  added_at timestamptz not null default now(),
  primary key (test_id, email)
);

create index if not exists test_audience_email_idx on public.test_audience (email);

alter table public.test_audience enable row level security;

-- A student may see that they are on a list, never who else is. The roll for a
-- test is a teacher's business.
drop policy if exists "test_audience: read own or admin" on public.test_audience;
create policy "test_audience: read own or admin"
  on public.test_audience for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email') or public.is_admin());

drop policy if exists "test_audience: admins manage" on public.test_audience;
create policy "test_audience: admins manage"
  on public.test_audience for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --- visibility ------------------------------------------------------------

-- Reads only test_audience, never public.tests. Reading `tests` from inside a
-- policy ON `tests` is the kind of thing that works until it does not, and the
-- audience column is already available to the policy as a plain column.
create or replace function public.in_test_audience(p_test_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.test_audience a
    where a.test_id = p_test_id
      and lower(a.email) = lower(auth.jwt() ->> 'email')
  );
$$;

revoke all on function public.in_test_audience(uuid) from public, anon;
grant execute on function public.in_test_audience(uuid) to authenticated;

drop policy if exists "tests: read published" on public.tests;
create policy "tests: read published"
  on public.tests for select to authenticated
  using (
    public.is_admin()
    or (
      status = 'published'
      and (audience = 'all' or public.in_test_audience(id))
    )
  );

-- --- reading an exam, now audience-aware -----------------------------------

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

  -- This function runs as its owner and so is not filtered by the policy
  -- above. A student with a direct link would otherwise walk straight past it.
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

revoke all on function public.get_exam(uuid) from public, anon;
grant execute on function public.get_exam(uuid) to authenticated;

-- --- and grading -----------------------------------------------------------

-- Same reasoning: submit_exam is SECURITY DEFINER, so the policy does not
-- protect it. Reaching here without an attempt row is already impossible, but
-- this makes the rule true of the grading path on its own terms.
create or replace function public.submit_exam_audience_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.tests t
    where t.id = new.test_id
      and t.audience = 'selected'
      and not exists (
        select 1 from public.test_audience a
        where a.test_id = t.id and lower(a.email) = lower(new.email)
      )
  ) then
    raise exception 'This test was not assigned to you.';
  end if;

  return new;
end;
$$;

drop trigger if exists exam_attempts_audience_guard on public.exam_attempts;
create trigger exam_attempts_audience_guard
  before insert on public.exam_attempts
  for each row execute function public.submit_exam_audience_guard();
