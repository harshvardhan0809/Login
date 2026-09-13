-- ===========================================================================
-- The deadline locks the hand-in.
--
-- Until now a student could keep replacing their link forever, which makes a
-- due date decorative. After this migration, once an assignment's deadline has
-- passed a student can no longer submit, replace or withdraw their work.
--
-- Teachers are unaffected: the "admins manage" policy still lets a teacher fix
-- or remove a submission, and extending an assignment's due date reopens it
-- for everyone -- which is the intended way to grant an extension.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- --- when does an assignment close? ----------------------------------------

-- assignments.due_date is a calendar date, so "due 12 September" means the
-- student has all of the 12th. The cut-off is therefore midnight at the END
-- of that day, not its start.
--
-- That midnight is interpreted in the timezone below.
--
-- CHANGE THIS ONE LINE if your school is not in India. It must match where
-- your students actually are, because the browser works the deadline out in
-- ITS local timezone: if the two disagree, the page and the database disagree
-- about whether an assignment is still open. Leaving this as 'UTC' for a
-- school in India would quietly grant everyone an extra five and a half hours.
create or replace function public.school_timezone()
returns text
language sql
immutable
as $$
  select 'Asia/Kolkata';
$$;

-- NULL due_date means no deadline, so the assignment never closes.
-- A missing assignment returns false: nothing to hand in to.
create or replace function public.assignment_is_open(p_assignment_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(
    (
      select a.due_date is null
          or now() < ((a.due_date + 1)::timestamp at time zone public.school_timezone())
      from public.assignments a
      where a.id = p_assignment_id
    ),
    false
  );
$$;

revoke all on function public.assignment_is_open(uuid) from public, anon;
grant execute on function public.assignment_is_open(uuid) to authenticated;

-- --- student policies, now deadline-aware ----------------------------------

-- Handing in for the first time.
drop policy if exists "submissions: hand in own" on public.assignment_submissions;
create policy "submissions: hand in own"
  on public.assignment_submissions for insert to authenticated
  with check (
    email = auth.jwt() ->> 'email'
    and public.assignment_is_open(assignment_id)
  );

-- Replacing a link.
--
-- USING is checked against the row as it stands and WITH CHECK against the row
-- as it would become. The deadline test belongs in BOTH: without it in USING a
-- student could edit a locked row, and without it in WITH CHECK they could
-- move a submission onto an assignment that has already closed.
drop policy if exists "submissions: replace own" on public.assignment_submissions;
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

-- Withdrawing. Deleting after the deadline would be a way to erase a hand-in
-- a teacher has not marked yet, so it closes with everything else.
drop policy if exists "submissions: withdraw own" on public.assignment_submissions;
create policy "submissions: withdraw own"
  on public.assignment_submissions for delete to authenticated
  using (
    email = auth.jwt() ->> 'email'
    and public.assignment_is_open(assignment_id)
  );

-- The admin policy is deliberately left as it was: a teacher must still be
-- able to correct or remove a submission after the deadline.
