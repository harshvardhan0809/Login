-- ===========================================================================
-- Handing in an assignment as a link.
--
-- Students do the work in Google Docs, Drive, or anywhere else with a URL and
-- hand in the address. Nothing is uploaded here: the file stays where the
-- student made it, which is what they are already doing informally.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- Off by default. An assignment that is only an announcement ("read chapter
-- four") should not grow a Submit button it does not want.
alter table public.assignments
  add column if not exists accepts_submissions boolean not null default false;

create table if not exists public.assignment_submissions (
  assignment_id uuid not null references public.assignments (id) on delete cascade,
  email text not null,
  link_url text not null,
  note text,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One hand-in per student per assignment; resubmitting replaces the link.
  primary key (assignment_id, email)
);

do $$
begin
  alter table public.assignment_submissions add constraint submissions_link_check
    check (link_url ~* '^https?://');
exception when duplicate_object then null;
end $$;

create index if not exists submissions_assignment_idx
  on public.assignment_submissions (assignment_id, submitted_at desc);

alter table public.assignment_submissions enable row level security;

-- --- who owns a submission -------------------------------------------------

-- The owner is the signed-in identity, always, whatever the client sent.
-- The policies below would already refuse a forged address; this makes the
-- browser's copy irrelevant rather than merely rejected, and keeps the first
-- submitted_at when a student replaces their link.
create or replace function public.stamp_submission_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.email := auth.jwt() ->> 'email';

  if new.email is null then
    raise exception 'You must be signed in to submit work.';
  end if;

  if tg_op = 'UPDATE' then
    new.submitted_at := old.submitted_at;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists submissions_stamp_owner on public.assignment_submissions;
create trigger submissions_stamp_owner
  before insert or update on public.assignment_submissions
  for each row execute function public.stamp_submission_owner();

-- --- policies --------------------------------------------------------------

-- A student sees only their own hand-in; a teacher sees the whole class.
drop policy if exists "submissions: read own or admin" on public.assignment_submissions;
create policy "submissions: read own or admin"
  on public.assignment_submissions for select to authenticated
  using (email = auth.jwt() ->> 'email' or public.is_admin());

drop policy if exists "submissions: hand in own" on public.assignment_submissions;
create policy "submissions: hand in own"
  on public.assignment_submissions for insert to authenticated
  with check (email = auth.jwt() ->> 'email');

-- Replacing a link is allowed; replacing somebody else's is not, which is why
-- both USING and WITH CHECK name the same address.
drop policy if exists "submissions: replace own" on public.assignment_submissions;
create policy "submissions: replace own"
  on public.assignment_submissions for update to authenticated
  using (email = auth.jwt() ->> 'email')
  with check (email = auth.jwt() ->> 'email');

drop policy if exists "submissions: withdraw own" on public.assignment_submissions;
create policy "submissions: withdraw own"
  on public.assignment_submissions for delete to authenticated
  using (email = auth.jwt() ->> 'email');

drop policy if exists "submissions: admins manage" on public.assignment_submissions;
create policy "submissions: admins manage"
  on public.assignment_submissions for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());
