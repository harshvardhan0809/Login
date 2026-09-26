-- ===========================================================================
-- Locks down role assignment and table access.
--
-- Before this migration the browser inserted its own role row, so anyone could
-- make themselves an admin from the console, and every table was readable and
-- writable with the public anon key. Run this once against your project:
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--   (or: supabase db push)
--
-- It is idempotent: re-running it is safe.
-- ===========================================================================

-- --- users ----------------------------------------------------------------

-- The old client-side signup inserted a row on every sign-up with no conflict
-- handling and no unique constraint, so duplicate emails are likely. Collapse
-- them before adding the index, keeping the most privileged row per address
-- (an existing admin must not be demoted by this cleanup).
delete from public.users a
using public.users b
where a.ctid < b.ctid
  and lower(a.email) = lower(b.email)
  and (a.role is distinct from 'admin' or b.role = 'admin');

-- Any remaining duplicates differ only by case; normalise then dedupe again.
update public.users set email = lower(email) where email <> lower(email);

delete from public.users a
using public.users b
where a.ctid < b.ctid
  and a.email = b.email;

-- The trigger below upserts on email, which needs a uniqueness guarantee.
create unique index if not exists users_email_key on public.users (email);

-- Role must never be null or an arbitrary string.
alter table public.users
  alter column role set default 'student';

update public.users set role = 'student' where role is null;

alter table public.users
  alter column role set not null;

do $$
begin
  alter table public.users
    add constraint users_role_check check (role in ('student', 'admin'));
exception
  when duplicate_object then null;
end
$$;

-- Every new auth user gets exactly one row, always as a student. Running as
-- SECURITY DEFINER means the row is created by the database, not the client,
-- so the client never gets to choose its own role.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (email, role)
  values (new.email, 'student')
  on conflict (email) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill anyone who signed up before the trigger existed.
insert into public.users (email, role)
select u.email, 'student'
from auth.users u
where u.email is not null
on conflict (email) do nothing;

-- Clients may read, never write. Promotion happens via the service role key
-- (npm run admin:promote), which bypasses RLS by design.
revoke insert, update, delete on public.users from anon, authenticated;

alter table public.users enable row level security;

drop policy if exists "users: read own row" on public.users;
create policy "users: read own row"
  on public.users for select to authenticated
  using (email = auth.jwt() ->> 'email');

-- --- admin helper ---------------------------------------------------------

-- SECURITY DEFINER so it can see public.users regardless of that table's RLS.
create or replace function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.users
    where email = auth.jwt() ->> 'email'
      and role = 'admin'
  );
$$;

-- --- tests ----------------------------------------------------------------

alter table public.tests enable row level security;

-- Students may read released tests only. Migration 0008 adds tests.status;
-- until it has run there is nothing to filter on, so this policy adapts rather
-- than either failing on a fresh database or, when re-run later, quietly
-- re-exposing every draft to students.
drop policy if exists "tests: read for signed-in users" on public.tests;
drop policy if exists "tests: read published" on public.tests;

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'tests' and column_name = 'status'
  ) then
    execute 'create policy "tests: read published" on public.tests '
         || 'for select to authenticated '
         || 'using (status = ''published'' or public.is_admin())';
  else
    execute 'create policy "tests: read published" on public.tests '
         || 'for select to authenticated using (true)';
  end if;
end $$;

drop policy if exists "tests: admins manage" on public.tests;
create policy "tests: admins manage"
  on public.tests for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --- results --------------------------------------------------------------

alter table public.results enable row level security;

-- A student sees only their own attempts; admins see the whole cohort.
drop policy if exists "results: read own or admin" on public.results;
create policy "results: read own or admin"
  on public.results for select to authenticated
  using (email = auth.jwt() ->> 'email' or public.is_admin());

-- Deliberately NO student insert policy. Scores are written by submit_exam()
-- (migration 0007), which grades on the server. A policy allowing students to
-- insert their own rows would let anyone POST themselves 100%.
drop policy if exists "results: insert own" on public.results;

drop policy if exists "results: admins manage" on public.results;
create policy "results: admins manage"
  on public.results for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --- avatars storage ------------------------------------------------------

-- Each user may only write inside a folder named after their own uid, which is
-- the path uploadAvatar() builds.
drop policy if exists "avatars: read" on storage.objects;
create policy "avatars: read"
  on storage.objects for select
  using (bucket_id = 'avatars');

drop policy if exists "avatars: write own folder" on storage.objects;
create policy "avatars: write own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "avatars: update own folder" on storage.objects;
create policy "avatars: update own folder"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
