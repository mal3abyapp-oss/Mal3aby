-- SECURITY FIX: sales_tenant_activation_invites' original schema
-- migration (20260904120000) revoked ALL from `public` and `anon`, but
-- never explicitly revoked from `authenticated` before issuing its
-- column-level `grant select (...)`. Supabase's default schema-level
-- grant gives `authenticated` INSERT/SELECT/UPDATE/DELETE/REFERENCES on
-- every new `public` schema table at creation time unless explicitly
-- revoked -- the column-level grant this migration added only ADDS
-- select on the safe columns, it does not by itself remove the
-- pre-existing blanket table-level grant. Confirmed live via
-- information_schema.role_column_grants: `authenticated` had
-- SELECT/INSERT/UPDATE/REFERENCES on token_hash AND secret_hash --
-- exactly the class of exposure 20260824080000 fixed for portal_invites
-- (there, retrofitted after the fact; here, caught before this table
-- was ever used by the newly-added Phase 14 structural regression
-- check 11, before this PR even merged to main).
--
-- IMPACT ASSESSMENT: token_hash is 256 bits of entropy (not practically
-- brute-forceable even if read). secret_hash is ~40 bits (sha256, fast,
-- not memory-hard) -- offline-brute-forceable on a consumer GPU, and
-- its entropy budget was only ever justified against the online
-- 5-attempt-lockout path, exactly per 20260824080000's own reasoning
-- for the identical portal_invites column. Any authenticated platform
-- staff account (or one compromised via a phished password) could have
-- read secret_hash directly via PostgREST, recovered the plaintext
-- activation secret offline, and combined it with a known/guessed
-- owner_email to complete account takeover of a pending invite --
-- bypassing the rate-limited online verification path entirely.
--
-- Not yet exploitable in practice: zero rows exist in this table (no
-- lead has been converted through this flow in production yet, verified
-- live before writing this fix) and INSERT/UPDATE by `authenticated`
-- were never reachable through the app's own RLS INSERT/UPDATE policies
-- (only a SELECT policy exists on this table -- see
-- sales_tenant_activation_invites_select -- so a direct client INSERT/
-- UPDATE would still be blocked by RLS even though the column grant
-- permitted it at the grant layer; SELECT was the real, RLS-permitted
-- exposure). Fixed here before any real invite has ever been minted.
--
-- THE FIX: explicit revoke all on this table from `authenticated` FIRST,
-- then re-issue the exact same column-level select grant this table's
-- own schema migration already intended -- token_hash/secret_hash
-- excluded, matching portal_invites' corrected convention exactly.

revoke all on public.sales_tenant_activation_invites from authenticated;

grant select (
  id, lead_id, business_name, business_name_ar, business_type, city, country,
  contact_phone, contact_phone_e164, owner_email, purpose, status,
  email_verified_at, secret_verified_at, verification_attempt_count,
  expires_at, consumed_at, activated_club_id, activated_user_id,
  created_at, created_by
) on public.sales_tenant_activation_invites to authenticated;

comment on column public.sales_tenant_activation_invites.token_hash is
  'sha256 of the raw activation token. NOT granted to authenticated (see 20260904120400 -- the original schema migration missed the explicit authenticated revoke, exposing this column via Supabase''s default schema-level grant; fixed before any real invite existed). Read only via SECURITY DEFINER RPCs / service_role.';
comment on column public.sales_tenant_activation_invites.secret_hash is
  'sha256 of the 8-character/32-symbol activation secret (~40 bits entropy, offline-brute-forceable via fast sha256 -- the online 5-attempt lockout is only a real defense if this column is never directly selectable). NOT granted to authenticated (see 20260904120400). Read only via SECURITY DEFINER RPCs / service_role.';
