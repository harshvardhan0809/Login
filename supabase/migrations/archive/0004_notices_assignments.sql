-- ===========================================================================
-- Notice board + assignments.
--
-- REQUIRED for the Notices and Assignments sections of the dashboard and
-- admin panel.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- --- notices --------------------------------------------------------------

create table if not exists public.notices (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);

-- Pinned first, then newest — the exact order the dashboard renders.
create index if not exists notices_order_idx
  on public.notices (pinned desc, created_at desc);

alter table public.notices enable row level security;

drop policy if exists "notices: read for signed-in users" on public.notices;
create policy "notices: read for signed-in users"
  on public.notices for select to authenticated
  using (true);

drop policy if exists "notices: admins manage" on public.notices;
create policy "notices: admins manage"
  on public.notices for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- --- assignments ----------------------------------------------------------

-- due_date is a plain date, not a timestamp: "due Friday" means the same day
-- everywhere, and a timestamptz would shift across time zones.
create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  subject text not null,
  description text,
  due_date date,
  link_url text,
  created_at timestamptz not null default now()
);

create index if not exists assignments_due_idx on public.assignments (due_date);

alter table public.assignments enable row level security;

drop policy if exists "assignments: read for signed-in users" on public.assignments;
create policy "assignments: read for signed-in users"
  on public.assignments for select to authenticated
  using (true);

drop policy if exists "assignments: admins manage" on public.assignments;
create policy "assignments: admins manage"
  on public.assignments for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
