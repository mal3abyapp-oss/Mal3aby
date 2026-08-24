-- SECURITY FIX: restrict the staff-facing SELECT surface on
-- public.portal_invites to exclude token_hash / secret_hash
-- (2026-08-24).
--
-- WHAT WAS WRONG: 20260823050000_customer_portal_zero_cost_activation.sql
-- created portal_invites_select_club_staff as a table-level RLS SELECT
-- policy (club_id in user_club_ids() AND has_permission('customer.view',
-- club_id)) with no column-level restriction, and then issued a
-- blanket `grant select on public.portal_invites to authenticated`
-- (line 119 of that migration). That grant covers every column,
-- including token_hash and -- three migrations later, once
-- 20260823080000_activation_independent_secret_factor.sql added it via
-- plain `alter table ... add column` (which inherits the table's
-- existing grants automatically) -- secret_hash too.
--
-- token_hash being broadly readable was a deliberate, reasoned
-- tradeoff (see the original migration's own comment: "harmless even
-- if selected... excluded from the staff-facing read surface below by
-- convention" -- the raw token carries 256 bits of entropy, so the
-- hash is not brute-forceable). secret_hash is different in kind: per
-- 20260823080000's own doc comment, the activation secret is only an
-- 8-character code from a 32-symbol alphabet (~40 bits of entropy),
-- and that entropy budget is explicitly justified there ONLY against
-- the online, 5-attempt-then-lockout verification path -- not against
-- offline brute force. sha256 (used for secret_hash, matching
-- token_hash's convention) is fast and not memory-hard, so 2^40
-- candidates is trivial to brute-force offline on a consumer GPU.
--
-- Because ADD COLUMN silently inherits table grants, secret_hash ended
-- up covered by the SAME blanket `grant select ... to authenticated`
-- that was reasoned about only for token_hash. Any staff account with
-- ordinary customer.view permission (a common, low-privilege
-- permission used throughout this codebase) -- or an attacker who
-- compromises one, e.g. via a phished password -- can read
-- token_hash AND secret_hash directly through PostgREST, recover the
-- plaintext activation secret offline, and combine it with the
-- already-known customer phone number and the token-bearing URL to
-- complete a full account takeover, entirely bypassing the online
-- rate-limited path the whole design relies on as its real defense.
--
-- THE FIX: replace the blanket table-level grant with an explicit
-- column-level grant that excludes token_hash and secret_hash. This
-- matches qr_credentials' own established convention (raw hash
-- columns are never exposed to broad grants) and requires no RLS
-- policy change -- the row-level filter (club_id/has_permission) was
-- already correct; only the column surface was too wide.
--
-- SAFETY: every genuine write/read path in this app already goes
-- through SECURITY DEFINER RPCs (_create_portal_invite_internal,
-- verify_portal_invite_phone, verify_portal_invite_secret,
-- claim_portal_invite, claim_portal_invite_service,
-- get_portal_invite_context) or the activate-portal-account edge
-- function, which uses the service_role key (still granted full
-- select via `grant select on public.portal_invites to service_role`,
-- untouched here) and therefore bypasses table grants entirely. A
-- grep across src/ confirms there is no direct
-- `.from('portal_invites')` client-side call anywhere in the frontend
-- -- the only consumer of the `authenticated`-role grant is the
-- Customer 360 "Portal Account" status display, which only ever needs
-- non-secret status columns. Revoking column-level select on
-- token_hash/secret_hash for `authenticated` therefore cannot break
-- any confirmed-working flow.

revoke select on public.portal_invites from authenticated;

grant select (
  id,
  club_id,
  customer_id,
  purpose,
  status,
  phone_verified_at,
  secret_verified_at,
  expires_at,
  consumed_at,
  triggering_booking_id,
  created_at,
  created_by,
  phone_attempt_count,
  verification_attempt_count
) on public.portal_invites to authenticated;

comment on column public.portal_invites.token_hash is
  'sha256 of the raw activation token (256 bits of entropy in the raw token itself -- hash is not practically brute-forceable). Deliberately NOT granted to the authenticated role (see 20260824080000) -- read only via SECURITY DEFINER RPCs / service_role.';

comment on column public.portal_invites.secret_hash is
  'sha256 of the 8-character/32-symbol activation secret (~40 bits of entropy, offline-brute-forceable via fast sha256). NOT granted to the authenticated role (see 20260824080000) -- the online 5-attempt lockout is only a real defense if this column is never directly selectable. Read only via SECURITY DEFINER RPCs / service_role.';
