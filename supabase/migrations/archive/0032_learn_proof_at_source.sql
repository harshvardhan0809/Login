-- ===========================================================================
-- Learn the proof fingerprint where it is observed, not one request later.
--
-- The proof was being recorded correctly and then not learned. Everything
-- worked when driven by hand and failed on a real launch, three times over,
-- because the learning lived in get_exam() and so depended on a chain of
-- circumstances holding:
--
--   * a second request arriving afterwards,
--   * in the right order,
--   * carrying a user agent Postgres still recognised as SEB,
--   * within the proof's thirty-minute window.
--
-- That is four ways to fail for something that should not be able to fail at
-- all. api/seb-verify already knows the test, the teacher and the digest, in
-- one transaction, with the SEB keys in its hands. So it learns the fingerprint
-- itself, and get_exam() merely reads what was stored.
--
-- Dropping the user-agent condition loses nothing: the presence of a valid
-- exam-key digest is far stronger evidence of a genuine SEB than a user agent,
-- which anyone can type. The digest is the evidence; the string was decoration.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe. Needs 0028 first.
-- ===========================================================================

create or replace function public.record_seb_proof(
  p_secret text,
  p_test_id uuid,
  p_config_key_hash text,
  p_request_hash text,
  p_user_agent text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  text := auth.jwt() ->> 'email';
  v_secret text;
  v_digest text;
begin
  if v_email is null then
    return false;
  end if;

  select value into v_secret from public.app_secrets where name = 'seb_proof_secret';

  -- Not configured yet, or the wrong secret: record nothing and say so. The
  -- caller learns only true/false, never the secret itself.
  if v_secret is null or p_secret is null or p_secret <> v_secret then
    return false;
  end if;

  -- The Config Key digest is preferred because it depends only on the exam
  -- configuration, so it survives a SEB version upgrade.
  v_digest := coalesce(nullif(p_config_key_hash, ''), nullif(p_request_hash, ''));

  -- Nothing to record is not an error: a browser that sent no keys simply has
  -- no proof to offer, and the exam gate decides what that means.
  if v_digest is null then
    return false;
  end if;

  insert into public.seb_proofs (test_id, email, config_key_hash, request_hash, user_agent)
  values (p_test_id, v_email, nullif(p_config_key_hash, ''), nullif(p_request_hash, ''),
          left(p_user_agent, 500))
  on conflict (test_id, email) do update
    set config_key_hash = excluded.config_key_hash,
        request_hash = excluded.request_hash,
        user_agent = excluded.user_agent,
        seen_at = now();

  -- A teacher's own SEB is what a test learns from, and this is the moment to
  -- learn it: same transaction, digest in hand, nothing left to go wrong
  -- afterwards. Re-learned on every visit, so changing the config or upgrading
  -- SEB heals itself the next time a teacher opens the paper.
  if public.is_admin() then
    insert into public.test_lockdown (test_id, seb_proof_fingerprint, seb_proof_at,
                                      seb_fingerprint_by)
    values (p_test_id, v_digest, now(), v_email)
    on conflict (test_id) do update
      set seb_proof_fingerprint = excluded.seb_proof_fingerprint,
          seb_proof_at = excluded.seb_proof_at,
          seb_fingerprint_by = excluded.seb_fingerprint_by,
          updated_at = now();
  end if;

  return true;
end;
$$;

revoke all on function public.record_seb_proof(text, uuid, text, text, text) from public, anon;
grant execute on function public.record_seb_proof(text, uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';
