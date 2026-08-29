-- SAAS ACCEPTANCE REVIEW -- Platform Owner acceptance findings PF-1,
-- PF-3, plus the claim_manual_payment idempotency gap flagged by the
-- idempotency/concurrency audit (2026-08-29).

-- FINDING PF-1 (P1): start_platform_support_session()'s p_reason is
-- optional and unvalidated, unlike every other dangerous
-- platform-owner action on this codebase (suspend/cancel/reverse-
-- payment all require a real, non-empty reason both client- and
-- server-side). Live-confirmed: 5 of 16 real support sessions in
-- production have no reason recorded, showing as "--" on the
-- platform's own accountability screen (PlatformSupportHistoryPage).
-- A 'manage'-mode session grants live write-impersonation into a
-- customer's club -- the single most sensitive capability on the
-- entire platform-owner surface -- and deserves the same reason
-- discipline as a club suspension.
--
-- Fix: require a real, non-empty reason for 'manage' mode
-- specifically (mirroring platform_suspend_club's own validation
-- pattern). 'view' mode (read-only support) keeps reason optional --
-- it's lower-stakes and the acceptance finding's own evidence
-- (5 blank reasons) doesn't distinguish which mode those sessions
-- were, so this is the narrowest fix that closes the real gap
-- without over-restricting a lower-risk action.
create or replace function public.start_platform_support_session(p_club_id uuid, p_mode text, p_reason text DEFAULT NULL::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_prior_session record;
  v_session_id uuid;
begin
  if p_mode not in ('view', 'manage') then
    raise exception 'invalid mode';
  end if;

  if p_mode = 'manage' and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'a reason is required to start a manage-mode support session';
  end if;

  if not (
    public.is_platform_owner()
    or public.has_platform_permission(case when p_mode = 'manage' then 'platform.support.start_manage' else 'platform.support.start_view' end)
  ) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.clubs where id = p_club_id) then
    raise exception 'club not found';
  end if;

  for v_prior_session in
    select id, club_id from public.platform_support_sessions
    where platform_owner_id = auth.uid() and ended_at is null
  loop
    update public.platform_support_sessions set ended_at = now() where id = v_prior_session.id;
    perform public.write_audit_log(
      v_prior_session.club_id, 'platform_support.session_ended', 'platform_support_session', v_prior_session.id,
      null, jsonb_build_object('auto_ended_by', 'new_session_started'), null
    );
  end loop;

  insert into public.platform_support_sessions (platform_owner_id, club_id, mode, reason)
  values (auth.uid(), p_club_id, p_mode, p_reason)
  returning id into v_session_id;

  perform public.write_audit_log(
    p_club_id, 'platform_support.session_started', 'platform_support_session', v_session_id,
    null, jsonb_build_object('mode', p_mode, 'reason', p_reason), p_reason
  );

  perform public.record_platform_club_access(p_club_id);

  return v_session_id;
end;
$function$;

-- FINDING PF-3 (P1): deactivate_platform_staff() has none of
-- set_platform_staff_role()'s lockout protection -- it can deactivate
-- the last remaining staff-role-assigner with zero warning, unlike
-- its sibling which explicitly guards this exact scenario (see
-- set_platform_staff_role's v_remaining_assigners check, added in an
-- earlier pass). Independently confirmed by a delegated
-- security-reviewer subagent with the identical root cause.
--
-- Fix: add the same remaining-assigner guard, checked BEFORE the
-- deactivation, mirroring set_platform_staff_role's own query
-- structure exactly (same permission key,
-- 'platform.staff.role.assign', and the same is_platform_owner()
-- exemption via count_active_platform_owners()).
create or replace function public.deactivate_platform_staff(p_membership_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership public.platform_staff_memberships;
  v_remaining_assigners int;
begin
  if not public.has_platform_permission('platform.staff.disable') then
    raise exception 'not authorized';
  end if;

  select * into v_membership from public.platform_staff_memberships where id = p_membership_id;
  if v_membership.id is null then
    raise exception 'platform staff member not found';
  end if;

  if v_membership.status = 'inactive' then
    return;
  end if;

  select count(*) into v_remaining_assigners
  from public.platform_staff_memberships psm
  left join public.platform_role_permissions prp on prp.platform_role_id = psm.platform_role_id
  left join public.platform_custom_role_permissions pcrp on pcrp.platform_custom_role_id = psm.platform_custom_role_id
  join public.platform_permissions pp on pp.id = coalesce(prp.platform_permission_id, pcrp.platform_permission_id)
  where psm.status = 'active' and psm.id != p_membership_id and pp.key = 'platform.staff.role.assign';

  if v_remaining_assigners = 0 and public.count_active_platform_owners() = 0 then
    raise exception 'this is the last account able to manage platform staff roles -- assign another one first';
  end if;

  update public.platform_staff_memberships set status = 'inactive', updated_at = now() where id = p_membership_id;

  -- Force-end any active support session this employee holds (directive
  -- Section 15).
  update public.platform_support_sessions
  set ended_at = now()
  where platform_owner_id = v_membership.user_id and ended_at is null;

  perform public.write_audit_log(
    null, 'platform_staff.disabled', 'platform_staff_membership', p_membership_id,
    jsonb_build_object('status', 'active'), jsonb_build_object('status', 'inactive'), null
  );
end;
$function$;

-- IDEMPOTENCY AUDIT finding: claim_manual_payment() (the customer-
-- facing "I paid, here's my proof" claim submission) has no
-- idempotency key and no natural dedup beyond the existing "one
-- pending claim per invoice" check. A duplicate claim row from a
-- double-submit is a staff-review nuisance (not a double-payment,
-- since only the separate verify_manual_payment_claim() ->
-- record_payment() step moves real money), but the existing pending-
-- claim check already only blocks a SECOND *pending* claim -- it
-- doesn't stop a genuine double-click from racing past it before the
-- first insert commits. Add a real idempotency key with the same
-- optional, backward-compatible pattern used everywhere else in this
-- session's fixes.
alter table public.manual_payment_claims add column if not exists idempotency_key uuid;
create unique index if not exists manual_payment_claims_invoice_idempotency_key_unique
  on public.manual_payment_claims (invoice_id, idempotency_key) where idempotency_key is not null;

create or replace function public.claim_manual_payment(p_invoice_id uuid, p_payment_method_config_id uuid, p_claimed_amount numeric, p_reference text DEFAULT NULL::text, p_proof_note text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_claim_id uuid;
  v_club_id uuid;
  v_customer_id uuid;
  v_invoice_status text;
  v_booking_status text;
  v_existing_pending_id uuid;
  v_existing_replay_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select i.club_id, i.customer_id, i.status into v_club_id, v_customer_id, v_invoice_status
  from public.invoices i
  join public.customers c on c.id = i.customer_id
  where i.id = p_invoice_id and c.user_id = auth.uid();

  if v_club_id is null then
    raise exception 'invoice not found or does not belong to your account';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing_replay_id from public.manual_payment_claims
    where invoice_id = p_invoice_id and idempotency_key = p_idempotency_key;

    if v_existing_replay_id is not null then
      return v_existing_replay_id;
    end if;
  end if;

  if v_invoice_status != 'issued' then
    raise exception 'this invoice is no longer collectible';
  end if;

  select status into v_booking_status from public.bookings where invoice_id = p_invoice_id limit 1;
  if v_booking_status in ('cancelled', 'no_show') then
    raise exception 'this booking was % -- payment can no longer be claimed against it', v_booking_status;
  end if;

  if p_claimed_amount <= 0 then
    raise exception 'claimed amount must be positive';
  end if;

  select id into v_existing_pending_id
  from public.manual_payment_claims
  where invoice_id = p_invoice_id and status = 'pending'
  limit 1;

  if v_existing_pending_id is not null then
    raise exception 'a payment claim for this invoice is already pending review -- please wait for it to be reviewed before submitting another';
  end if;

  insert into public.manual_payment_claims (club_id, invoice_id, payment_method_config_id, claimed_by, claimed_amount, reference, proof_note, idempotency_key)
  values (v_club_id, p_invoice_id, p_payment_method_config_id, auth.uid(), p_claimed_amount, p_reference, p_proof_note, p_idempotency_key)
  returning id into v_claim_id;

  return v_claim_id;
end;
$function$;
