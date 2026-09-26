-- ===========================================================================
-- FIX -- the teacher's panel ignored the route that actually worked.
--
-- seb_check() read only the digests attached to its own request. On Windows
-- those never arrive, so the panel said "this Safe Exam Browser did not send
-- its verification headers" at a machine whose keys had in fact reached
-- api/seb-verify a moment earlier and been recorded correctly.
--
-- A check that reports failure on success is worse than no check: it sent us
-- hunting configs and versions while the mechanism was working.
--
-- So the panel now reads both roads, and says which one carried the proof.
--
--   Supabase Dashboard -> SQL Editor -> paste -> Run
--
-- Idempotent: re-running it is safe. Needs 0028 first.
-- ===========================================================================

create or replace function public.seb_check(p_test_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  t      public.tests%rowtype;
  v_urls text[] := public.seb_candidate_urls();
  v_fp   text   := public.seb_fingerprint_seen();
  v_proof text;
  s      public.test_lockdown%rowtype;
begin
  perform public.require_admin();

  select * into t from public.tests where id = p_test_id;
  if not found then
    raise exception 'That test no longer exists.';
  end if;

  select * into s from public.test_lockdown where test_id = p_test_id;

  -- What this browser showed api/seb-verify, which is the only route some
  -- platforms have. Read here so the panel stops reporting "not verified" at a
  -- machine that verified perfectly well by the other road.
  v_proof := public.seb_proof_of(p_test_id, auth.jwt() ->> 'email');

  return jsonb_build_object(
    'enforcement', t.seb_enforcement,
    'requires_seb', t.requires_seb,
    'looks_like_seb', public.request_is_seb(),
    'user_agent', left(public.request_user_agent(), 300),
    -- What this request proves about itself.
    -- Note this digest belongs to THIS endpoint's URL, so it is expected to
    -- differ from the stored one, which was learned from get_exam's URL.
    -- What matters here is that a digest arrived at all.
    'fingerprint_seen', v_fp,
    -- Either road counts. macOS supplies both; Windows only the second.
    'proof_headers_arrived', v_fp is not null or v_proof is not null,
    'direct_headers_arrived', v_fp is not null,
    'proof_recorded', v_proof is not null,
    'proof_fingerprint_stored', s.seb_proof_fingerprint,
    'proof_matches', v_proof is not null and v_proof = s.seb_proof_fingerprint,
    'verified', (v_fp is not null and v_fp = s.seb_fingerprint)
             or (v_proof is not null and v_proof = s.seb_proof_fingerprint),
    'fingerprint_stored', s.seb_fingerprint,
    'fingerprint_learned_at', s.seb_fingerprint_at,
    'request_hash', public.request_header('x-safeexambrowser-requesthash'),
    'config_key_hash', public.request_header('x-safeexambrowser-configkeyhash'),
    -- The manual key route from 0021, for tests that pin a specific build.
    'browser_exam_key_set', coalesce(s.seb_browser_exam_key, '') <> '',
    'config_key_set', coalesce(s.seb_config_key, '') <> '',
    'key_verified', public.seb_key_ok(s.seb_browser_exam_key, s.seb_config_key),
    'candidate_urls', to_jsonb(v_urls),
    'expected_request_hash', case
      when coalesce(s.seb_browser_exam_key, '') <> '' then to_jsonb(array(
        select encode(sha256(convert_to(u || s.seb_browser_exam_key, 'utf8')), 'hex')
        from unnest(v_urls) u))
    end,
    -- Every SEB header actually received, in case a proxy renames or drops
    -- them. If this is empty inside a real SEB, nothing above can work.
    'seb_headers', coalesce((
      select jsonb_object_agg(h.k, h.v)
      from json_each_text(nullif(current_setting('request.headers', true), '')::json)
           as h(k, v)
      where h.k like '%safeexam%' or h.k like '%seb%'
    ), '{}'::jsonb)
  );
end;
$$;

revoke all on function public.seb_check(uuid) from public, anon;
grant execute on function public.seb_check(uuid) to authenticated;

notify pgrst, 'reload schema';
