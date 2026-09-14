-- ===========================================================================
-- SECURITY FIX -- run this one first if you run nothing else.
--
-- public.users, public.tests and public.results were readable by ANYONE
-- holding the anon key, which is published in the JavaScript bundle by design.
-- That exposed every student's email address, every grade, and every test
-- including unpublished drafts, to the open internet.
--
-- Why the earlier migrations did not catch it: 0001 and its successors drop
-- policies BY NAME before recreating them. The original app -- before any of
-- this hardening existed -- had its own permissive policies under different
-- names, most likely the Supabase dashboard's "Enable read access for all
-- users" template. Nothing ever dropped those, so they sat alongside the
-- correct policies, and PostgreSQL OR's permissive policies together: one
-- policy saying `true` defeats every careful policy next to it.
--
-- So this migration does not trust names. It enumerates every policy actually
-- present on these tables, drops all of them, and rebuilds the correct set
-- from scratch. Afterwards, select public.security_report() to see exactly
-- what is in force rather than assuming.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- --- 1. drop every existing policy on the app's tables ---------------------

do $$
declare
  p record;
begin
  for p in
    select policyname, tablename
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'users', 'tests', 'results', 'questions', 'videos', 'notices',
        'assignments', 'assignment_submissions', 'exam_attempts',
        'test_secrets', 'test_audience'
      )
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

-- --- 2. make sure RLS is actually on -----------------------------------------

-- A table with RLS disabled ignores every policy below it. Not forced, because
-- the SECURITY DEFINER functions (get_exam, submit_exam, the admin_* family)
-- rely on the table owner bypassing RLS.
do $$
declare
  t text;
begin
  foreach t in array array[
    'users', 'tests', 'results', 'questions', 'videos', 'notices',
    'assignments', 'assignment_submissions', 'exam_attempts',
    'test_secrets', 'test_audience'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
end $$;

-- --- 3. re-assert the privilege revokes --------------------------------------

-- Stronger than any policy: a role cannot be granted access by a policy to
-- something it holds no privilege on. This is what stops a student writing
-- their own score even if a policy is later added by mistake.
revoke insert, update, delete on public.users from anon, authenticated;
revoke insert, update, delete on public.results from anon, authenticated;
revoke insert, update, delete on public.exam_attempts from anon, authenticated;

-- Nothing in this app is for signed-out visitors.
revoke all on public.users from anon;
revoke all on public.tests from anon;
revoke all on public.results from anon;
revoke all on public.questions from anon;
revoke all on public.exam_attempts from anon;
revoke all on public.test_secrets from anon;
revoke all on public.test_audience from anon;

do $$
declare
  t text;
begin
  foreach t in array array['videos', 'notices', 'assignments', 'assignment_submissions'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on public.%I from anon', t);
    end if;
  end loop;
end $$;

-- --- 4. rebuild the correct policies -----------------------------------------

-- users: your own row, or everything if you are a teacher. Writes are revoked;
-- roles change through admin_set_role() or the promote script.
create policy "users: read own or admin"
  on public.users for select to authenticated
  using (email = auth.jwt() ->> 'email' or public.is_admin());

-- tests: released, and either for everyone or for you specifically.
create policy "tests: read published"
  on public.tests for select to authenticated
  using (
    public.is_admin()
    or (
      status = 'published'
      and (audience = 'all' or public.in_test_audience(id))
    )
  );

create policy "tests: admins manage"
  on public.tests for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- results: your own marks, or the whole cohort if you are a teacher. No write
-- policy at all -- scores are written by submit_exam() and the admin_* family.
create policy "results: read own or admin"
  on public.results for select to authenticated
  using (email = auth.jwt() ->> 'email' or public.is_admin());

-- questions: teachers only. This table holds the answer keys.
create policy "questions: admins manage"
  on public.questions for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- exam_attempts: your own clock. Written only by get_exam()/submit_exam().
create policy "exam_attempts: read own or admin"
  on public.exam_attempts for select to authenticated
  using (email = auth.jwt() ->> 'email' or public.is_admin());

-- test_secrets: quit passwords. A student holding one can walk out mid-exam.
create policy "test_secrets: admins only"
  on public.test_secrets for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- test_audience: you may see that you are on a list, never who else is.
create policy "test_audience: read own or admin"
  on public.test_audience for select to authenticated
  using (lower(email) = lower(auth.jwt() ->> 'email') or public.is_admin());

create policy "test_audience: admins manage"
  on public.test_audience for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- Course content: any signed-in user reads, teachers write.
do $$
declare
  t text;
begin
  foreach t in array array['videos', 'notices', 'assignments'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;

    -- %I, not %L: a policy name is an identifier, not a string literal.
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || ': read for signed-in users', t
    );
    execute format(
      'create policy %I on public.%I for all to authenticated '
      || 'using (public.is_admin()) with check (public.is_admin())',
      t || ': admins manage', t
    );
  end loop;
end $$;

-- Hand-ins: your own, and only while the assignment is still open.
do $$
begin
  if to_regclass('public.assignment_submissions') is null then
    return;
  end if;

  create policy "submissions: read own or admin"
    on public.assignment_submissions for select to authenticated
    using (lower(email) = lower(auth.jwt() ->> 'email') or public.is_admin());

  create policy "submissions: hand in own"
    on public.assignment_submissions for insert to authenticated
    with check (
      email = auth.jwt() ->> 'email'
      and public.assignment_is_open(assignment_id)
    );

  create policy "submissions: replace own"
    on public.assignment_submissions for update to authenticated
    using (
      email = auth.jwt() ->> 'email'
      and public.assignment_is_open(assignment_id)
    )
    with check (
      email = auth.jwt() ->> 'email'
      and public.assignment_is_open(assignment_id)
    );

  create policy "submissions: withdraw own"
    on public.assignment_submissions for delete to authenticated
    using (
      email = auth.jwt() ->> 'email'
      and public.assignment_is_open(assignment_id)
    );

  create policy "submissions: admins manage"
    on public.assignment_submissions for all to authenticated
    using (public.is_admin())
    with check (public.is_admin());
end $$;

-- --- 5. a way to check, rather than assume -----------------------------------

-- Reports what is actually in force. The failure this migration fixes was
-- invisible precisely because nobody could see the whole picture in one place.
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
      -- The finding that started all this: any privilege at all for `anon`
      -- on these tables means the open internet can read them.
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
        'users', 'tests', 'results', 'questions', 'videos', 'notices',
        'assignments', 'assignment_submissions', 'exam_attempts',
        'test_secrets', 'test_audience'
      )
  ) x;

  return coalesce(v_report, '[]'::jsonb);
end;
$$;

revoke all on function public.security_report() from public, anon;
grant execute on function public.security_report() to authenticated;
