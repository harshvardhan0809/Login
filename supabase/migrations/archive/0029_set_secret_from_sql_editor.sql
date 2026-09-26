-- ===========================================================================
-- FIX -- admin_set_seb_secret() could not be run from the SQL editor.
--
-- 0028 documented setting the shared secret with
--
--   select public.admin_set_seb_secret('<value>');
--
-- and then guarded that function with require_admin(). But the Supabase SQL
-- editor connects directly to the database as `postgres`. There is no JWT on
-- such a connection, so auth.jwt() is null, is_admin() is false, and the only
-- documented way to set the secret failed with
--
--   42501  Only a teacher can do this.
--
-- The guard is right for a call arriving from the browser and wrong for a
-- direct connection, which by definition already holds full access to every
-- table — including app_secrets. Refusing it protects nothing.
--
-- So the check now also admits a caller with no JWT at all, and the service
-- role, in the same shape security_report() has used since 0015.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe. Needs 0028 first.
-- ===========================================================================

create or replace function public.admin_set_seb_secret(p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- A teacher from the app, the service role from a script, or a direct SQL
  -- connection, which has no JWT and needs no permission from us.
  if not (
    auth.jwt() is null
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or public.is_admin()
  ) then
    raise exception 'Only a teacher can do this.' using errcode = '42501';
  end if;

  if coalesce(btrim(p_value), '') = '' then
    raise exception 'The secret cannot be blank.';
  end if;
  if length(btrim(p_value)) < 32 then
    raise exception 'Use a longer secret — 32 characters at least. Try: openssl rand -hex 32';
  end if;

  insert into public.app_secrets (name, value)
  values ('seb_proof_secret', btrim(p_value))
  on conflict (name) do update
    set value = excluded.value, updated_at = now();
end;
$$;

revoke all on function public.admin_set_seb_secret(text) from public, anon;
grant execute on function public.admin_set_seb_secret(text) to authenticated;

-- A way to confirm the secret is set without printing it. Teachers only.
create or replace function public.seb_secret_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_len int;
  v_at  timestamptz;
begin
  if not (
    auth.jwt() is null
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role'
    or public.is_admin()
  ) then
    raise exception 'Only a teacher can do this.' using errcode = '42501';
  end if;

  select length(value), updated_at into v_len, v_at
  from public.app_secrets where name = 'seb_proof_secret';

  -- The length and the date, never the value.
  return jsonb_build_object(
    'set', v_len is not null,
    'length', v_len,
    'updated_at', v_at
  );
end;
$$;

revoke all on function public.seb_secret_status() from public, anon;
grant execute on function public.seb_secret_status() to authenticated;

notify pgrst, 'reload schema';
