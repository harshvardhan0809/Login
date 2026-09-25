-- ===========================================================================
-- FIX -- 0024 locked teachers out of their own lockdown settings.
--
-- 0024 created test_lockdown and then wrote:
--
--   revoke insert, update, delete on public.test_lockdown from authenticated;
--
-- That pattern is right for users, results and exam_attempts, where nothing
-- may ever write except a SECURITY DEFINER function. It is wrong here: the
-- admin page writes this table directly when a teacher saves a Browser Exam
-- Key. `authenticated` is the role every signed-in person holds, teachers
-- included, so the revoke hit them too and saving a test failed with
--
--   42501 permission denied for table test_lockdown
--
-- The automatic fingerprint kept working throughout, because get_exam() runs
-- as the table's owner and so is not subject to the grant -- which is exactly
-- why this was invisible until a teacher tried to paste a key by hand.
--
-- Restoring the privilege does not open the table up: the RLS policy from 0024
-- still limits every row to teachers, and a student's write matches no rows.
-- This is the same arrangement `tests` has always used.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe. Needs 0024 first.
-- ===========================================================================

grant insert, update, delete on public.test_lockdown to authenticated;

-- Signed-out visitors keep nothing at all.
revoke all on public.test_lockdown from anon;

-- Re-asserted so the privilege above can never be the whole story: rows are
-- still teachers-only, for reading and for writing.
drop policy if exists "test_lockdown: admins only" on public.test_lockdown;
create policy "test_lockdown: admins only"
  on public.test_lockdown for all to authenticated
  using (public.is_admin())
  with check (public.is_admin());

notify pgrst, 'reload schema';
