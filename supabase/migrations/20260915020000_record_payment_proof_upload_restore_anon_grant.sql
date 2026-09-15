-- AUDIT ROUND 3 FINDING (2026-09-15): record_payment_proof_upload() has
-- been silently anon-unreachable since 2026-08-21
-- (20260821004237_block_payment_on_cancelled_booking.sql), when a
-- `revoke execute ... from anon` for it was almost certainly copy-pasted
-- from that same migration's adjacent, CORRECTLY authenticated-only
-- claim_manual_payment()/record_payment() blocks. This is a genuine
-- production regression, not a deliberate tightening:
--   - src/features/public-booking/PaymentProofUpload.tsx's own doc
--     comment explicitly documents the intended design: "Uploads
--     directly to the private payment-proofs Storage bucket (anon-safe
--     INSERT policy), then records the metadata via
--     record_payment_proof_upload()".
--   - That component has no auth call anywhere in its upload flow (no
--     signInAnonymously(), no session check) and is mounted on two
--     genuinely anonymous routes: PublicClubBookingPage.tsx (/c/:slug)
--     and SecureBookingPage.tsx (/qr/:token) via PaymentMethodsPanel.
--   - 20260819210000_revoke_anon_staff_write_rpcs.sql's own migration
--     comment states explicitly: "record_payment_proof_upload is
--     deliberately left anon-executable: guest customers upload payment
--     receipts without an account" -- confirming anon access was a
--     documented, intentional design decision that the later migration
--     silently undid.
-- Net effect for the last ~3.5 weeks: every real anonymous customer
-- attempting to upload a payment proof via the in-app upload flow
-- (as opposed to sending it over WhatsApp, the other supported option)
-- has received a permission-denied error. The storage upload itself
-- still succeeds (that bucket's policy was untouched); only the
-- follow-up metadata-recording RPC call fails, so the proof silently
-- never reaches staff's review queue.
--
-- This migration restores the grant, and -- since this RPC is now
-- confirmed reachable by anon again -- adds a rate limiter as
-- defense-in-depth against a caller flooding one known booking_id's
-- review queue with junk pending-review rows (booking_id is an
-- unguessable UUID, so this bounds an already-narrow abuse surface,
-- not an open one). Reuses the exact fixed-window pattern already
-- proven for gateway_webhook_rate_limit_state/
-- check_gateway_webhook_rate_limit (20260903150100_gateway_webhook_
-- rate_limit_m5.sql), generalized to an arbitrary text key instead of
-- provider_key specifically, so this same table/function can back
-- future anon-callable-RPC rate limits without a new table each time.
create table public.rpc_rate_limit_state (
  rate_key text primary key,
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0
);

alter table public.rpc_rate_limit_state enable row level security;
alter table public.rpc_rate_limit_state force row level security;

-- No client access at all -- purely internal counter state written by
-- the service-role/security-definer RPC below.
revoke all on public.rpc_rate_limit_state from public, anon, authenticated;

-- Same fixed-window check-and-increment shape as
-- check_gateway_webhook_rate_limit, generalized: p_rate_key is caller-
-- constructed (e.g. 'payment_proof_upload:' || booking_id::text) so one
-- table serves every anon-reachable RPC that needs this pattern, each
-- keyed and thresholded independently by its own caller.
create or replace function public.check_rpc_rate_limit(
  p_rate_key text,
  p_max_requests integer default 20,
  p_window_seconds integer default 600
)
returns table(allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_window_elapsed numeric;
begin
  insert into public.rpc_rate_limit_state (rate_key)
  values (p_rate_key)
  on conflict (rate_key) do nothing;

  select * into v_row
  from public.rpc_rate_limit_state
  where rate_key = p_rate_key
  for update;

  v_window_elapsed := extract(epoch from (now() - v_row.window_started_at));

  if v_window_elapsed >= p_window_seconds then
    update public.rpc_rate_limit_state
    set window_started_at = now(), request_count = 1
    where rate_key = p_rate_key;
    return query select true, 0;
  end if;

  if v_row.request_count < p_max_requests then
    update public.rpc_rate_limit_state
    set request_count = v_row.request_count + 1
    where rate_key = p_rate_key;
    return query select true, 0;
  end if;

  return query select false, greatest(1, ceil(p_window_seconds - v_window_elapsed)::integer);
end;
$$;

revoke all on function public.check_rpc_rate_limit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.check_rpc_rate_limit(text, integer, integer) to service_role;

comment on function public.check_rpc_rate_limit(text, integer, integer) is
  'General-purpose fixed-window rate limiter for anon-reachable write RPCs, same pattern as check_gateway_webhook_rate_limit but keyed by an arbitrary caller-constructed text key instead of provider_key. Never used to permanently reject -- callers should raise a clear "try again shortly" exception, never a silent drop. Called from inside a SECURITY DEFINER RPC via a direct function call (not service-role-only), since these callers are reached through PostgREST directly, not via an Edge Function that could hold the service-role key itself.';

comment on table public.rpc_rate_limit_state is
  'Internal counter state for check_rpc_rate_limit(). One row per rate_key -- RPC access only via check_rpc_rate_limit(), never exposed to any client role directly.';

-- Restore the anon grant record_payment_proof_upload lost on 2026-08-21.
create or replace function public.record_payment_proof_upload(p_booking_id uuid, p_amount numeric, p_storage_path text, p_mime_type text, p_file_size_bytes integer, p_payment_method_config_id uuid DEFAULT NULL::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_booking record;
  v_proof_id uuid;
  v_expected_prefix text;
  v_rate_check record;
begin
  select id, club_id, invoice_id, customer_id, status into v_booking
  from public.bookings where id = p_booking_id;

  if v_booking.id is null then
    raise exception 'booking not found';
  end if;

  -- AUDIT ROUND 3: rate-limit BEFORE any further work, keyed per
  -- booking_id -- 10 uploads per booking per 10 minutes is far above
  -- any legitimate customer's real usage (at most a couple of retries
  -- after picking the wrong file), while still bounding a flood of
  -- junk pending-review rows against one known booking.
  select * into v_rate_check from public.check_rpc_rate_limit('payment_proof_upload:' || p_booking_id::text, 10, 600);
  if not v_rate_check.allowed then
    raise exception 'too many upload attempts for this booking -- please wait a few minutes and try again';
  end if;

  if v_booking.invoice_id is null then
    raise exception 'this booking has no invoice yet';
  end if;
  if v_booking.status in ('cancelled', 'no_show') then
    raise exception 'this booking was % -- its invoice is no longer collectible', v_booking.status;
  end if;
  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_mime_type not in ('image/jpeg', 'image/png', 'application/pdf') then
    raise exception 'unsupported file type';
  end if;
  if p_file_size_bytes > 10485760 then
    raise exception 'file exceeds the 10MB size limit';
  end if;

  v_expected_prefix := v_booking.club_id::text || '/' || p_booking_id::text || '/';
  if left(p_storage_path, length(v_expected_prefix)) != v_expected_prefix then
    raise exception 'storage path does not match this booking';
  end if;

  insert into public.payment_proofs (club_id, booking_id, invoice_id, customer_id, payment_method_config_id, amount, storage_path, mime_type, file_size_bytes)
  values (v_booking.club_id, p_booking_id, v_booking.invoice_id, v_booking.customer_id, p_payment_method_config_id, p_amount, p_storage_path, p_mime_type, p_file_size_bytes)
  returning id into v_proof_id;

  perform public.write_audit_log(v_booking.club_id, 'payment_proof.upload', 'payment_proof', v_proof_id, null,
    jsonb_build_object('booking_id', p_booking_id, 'amount', p_amount), null);

  perform public.emit_notification_event(v_booking.club_id, 'payment_proof.uploaded', 'payment_proof', v_proof_id,
    jsonb_build_object('booking_id', p_booking_id, 'amount', p_amount));

  return v_proof_id;
end;
$function$;

revoke all on function public.record_payment_proof_upload(uuid, numeric, text, text, integer, uuid) from public;
revoke all on function public.record_payment_proof_upload(uuid, numeric, text, text, integer, uuid) from authenticated;
grant execute on function public.record_payment_proof_upload(uuid, numeric, text, text, integer, uuid) to anon, authenticated;

comment on function public.record_payment_proof_upload(uuid, numeric, text, text, integer, uuid) is
  'The anon-reachable RPC backing PaymentProofUpload.tsx''s public "upload a payment proof" flow -- restored to anon+authenticated after a 2026-08-21 regression silently dropped anon access for ~3.5 weeks (see this migration''s own header for the full evidence trail). Validates the storage path actually belongs to this booking/club before accepting it, and is now rate-limited per booking_id via check_rpc_rate_limit() as defense-in-depth against review-queue flooding.';
