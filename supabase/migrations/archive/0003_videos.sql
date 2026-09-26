-- ===========================================================================
-- Video lessons: a library of learning content students can watch.
--
-- REQUIRED for the video sections of the dashboard and admin panel.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  subject text not null,
  description text,
  video_url text not null,
  created_at timestamptz not null default now()
);

-- Newest first is the only ordering the app uses.
create index if not exists videos_created_at_idx on public.videos (created_at desc);

alter table public.videos enable row level security;

-- Same shape as `tests`: any signed-in student may watch, only admins may
-- change the library. Without these policies RLS denies everything.
drop policy if exists "videos: read for signed-in users" on public.videos;
create policy "videos: read for signed-in users"
  on public.videos for select to authenticated
  using (true);

drop policy if exists "videos: admins manage" on public.videos;
create policy "videos: admins manage"
  on public.videos for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
