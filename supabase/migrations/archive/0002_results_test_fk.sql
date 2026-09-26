-- ===========================================================================
-- Adds the missing foreign key from results.test_id to tests.id.
--
-- OPTIONAL: the app does not need this. admin.js joins test titles in the
-- browser precisely because this key is absent. Apply it for data integrity —
-- without it nothing stops a result row pointing at a test that never existed,
-- or surviving after its test is deleted.
--
-- Applying it also makes PostgREST embeds such as `tests (title)` work, since
-- those resolve relationships through declared foreign keys.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe.
-- ===========================================================================

-- A foreign key cannot be added while orphan rows exist. Detach them rather
-- than deleting: a score is still worth keeping even if its test is gone.
update public.results
set test_id = null
where test_id is not null
  and test_id not in (select id from public.tests);

do $$
begin
  alter table public.results
    add constraint results_test_id_fkey
    foreign key (test_id) references public.tests (id)
    on delete set null;
exception
  when duplicate_object then null;
end
$$;

-- Every dashboard and admin query filters or joins on these.
create index if not exists results_test_id_idx on public.results (test_id);
create index if not exists results_email_idx on public.results (email);
