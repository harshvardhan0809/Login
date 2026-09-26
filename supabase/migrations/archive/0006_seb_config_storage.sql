-- ===========================================================================
-- Hosting for Safe Exam Browser config files.
--
-- Teachers should never have to host a .seb file themselves. The portal
-- generates one per test and uploads it here; the stored public URL is what
-- the student's seb:// link points at.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- Public on purpose. SEB fetches the config *before* anyone signs in, so it
-- cannot present a session token. The file contains only the exam URL and
-- lockdown settings — no credentials — so public read is acceptable.
insert into storage.buckets (id, name, public)
values ('seb-configs', 'seb-configs', true)
on conflict (id) do update set public = true;

-- Anyone may read a config (SEB itself is anonymous).
drop policy if exists "seb configs: public read" on storage.objects;
create policy "seb configs: public read"
  on storage.objects for select
  using (bucket_id = 'seb-configs');

-- Only admins may create, replace or remove one.
drop policy if exists "seb configs: admins write" on storage.objects;
create policy "seb configs: admins write"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'seb-configs' and public.is_admin());

drop policy if exists "seb configs: admins update" on storage.objects;
create policy "seb configs: admins update"
  on storage.objects for update to authenticated
  using (bucket_id = 'seb-configs' and public.is_admin());

drop policy if exists "seb configs: admins delete" on storage.objects;
create policy "seb configs: admins delete"
  on storage.objects for delete to authenticated
  using (bucket_id = 'seb-configs' and public.is_admin());
