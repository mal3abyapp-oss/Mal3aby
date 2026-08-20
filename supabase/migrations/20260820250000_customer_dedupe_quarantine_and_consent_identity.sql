-- Corrective migration, addressing three real gaps in the immediately
-- prior Customer 360 foundation migration, flagged before any further
-- frontend work:
--
-- 1. customers_club_phone_e164_unique previously excluded two specific
--    customer IDs by literal value. That is a permanent bypass hole,
--    not a review mechanism: a THIRD customer created later with the
--    same (club_id, phone_e164) as either excluded row would also
--    fall outside the index and slip through uncaught. Replaced with
--    a `duplicate_review_status` column the constraint excludes BY
--    STATUS, not by a fixed ID list -- so the invariant "no NEW
--    duplicate for a canonical (non-quarantined) identity" holds for
--    every future row, and quarantining is itself an explicit,
--    audited action (via quarantine_duplicate_customer()) rather than
--    a silent one-time carve-out baked into a migration.
--
-- 2. Confirmed (re-read on this pass): merged_into_customer_id is
--    schema-only, set by nothing, read by nothing. No merge occurred
--    and none will in this migration. Left as-is -- this file does not
--    touch it.
--
-- 3. notification_consent.phone_e164 was backfilled from the CURRENT
--    customer.phone_e164 in the prior migration. That is correct for
--    already-recorded consent (those rows were captured while that
--    was in fact the customer's phone -- no re-attribution occurred,
--    it's a one-time snapshot of already-true history). What must be
--    prevented is any FUTURE drift: record_staff_whatsapp_consent()
--    must snapshot the phone passed to it at decision time and must
--    never be invoked implicitly by a bare phone-number edit. Fixed
--    by making the function itself accept and store phone_e164
--    directly (previously only p_normalized_phone, the legacy digit-
--    string -- the audit's own finding #3) rather than relying on a
--    later join back to customers.phone_e164, which could silently
--    diverge the moment the customer's phone changes again after
--    consent was recorded for the earlier number.

-- 1. Duplicate quarantine status -- replaces the ID-list exclusion.
alter table public.customers
  add column if not exists duplicate_review_status text not null default 'none'
    check (duplicate_review_status in ('none', 'quarantined_pending_review'));

comment on column public.customers.duplicate_review_status is
  'none = canonical identity, participates in the (club_id, phone_e164) uniqueness constraint. quarantined_pending_review = flagged as a likely duplicate by quarantine_duplicate_customer(), temporarily excluded from that constraint so the record stays readable for staff review without blocking a legitimate new customer from claiming the same phone. Never set directly by UPDATE -- see quarantine_duplicate_customer() below.';

-- Quarantine the one pre-existing collision found during the prior
-- migration's audit ("Aliiii", zero bookings/invoices/payments,
-- created ~13h after "Ali" which has 6 of each -- clearly an
-- accidental duplicate, never merged/deleted here).
update public.customers
set duplicate_review_status = 'quarantined_pending_review'
where id = '8a398e82-5b24-4453-a8f1-3658d3425945'
  and duplicate_review_status = 'none';

-- Replace the ID-list-excluding index with a status-excluding one.
drop index if exists public.customers_club_phone_e164_unique;

create unique index customers_club_phone_e164_unique
  on public.customers (club_id, phone_e164)
  where phone_e164 is not null and duplicate_review_status = 'none';

-- Explicit, audited quarantine action -- the only sanctioned way to
-- set duplicate_review_status. Requires customer.update (same
-- permission boundary as every other customer mutation). Does NOT
-- touch bookings/invoices/payments/players/consent -- purely a review
-- flag, matching directive section 11 ("do NOT auto-merge... create a
-- review path") and section 39 ("no automatic merge... financial/
-- bookings data must be safely reassigned with audit" -- reassignment
-- is explicitly out of scope here, this only marks the record).
create or replace function public.quarantine_duplicate_customer(
  p_club_id uuid,
  p_customer_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  update public.customers
  set duplicate_review_status = 'quarantined_pending_review'
  where id = p_customer_id and club_id = p_club_id;

  if not found then
    raise exception 'customer not found';
  end if;

  perform public.write_audit_log(
    p_club_id, 'customer.quarantined_as_duplicate', 'customer', p_customer_id,
    jsonb_build_object('duplicate_review_status', 'none'),
    jsonb_build_object('duplicate_review_status', 'quarantined_pending_review', 'reason', p_reason),
    null
  );
end;
$function$;

revoke execute on function public.quarantine_duplicate_customer(uuid, uuid, text) from public;
revoke execute on function public.quarantine_duplicate_customer(uuid, uuid, text) from anon;
grant execute on function public.quarantine_duplicate_customer(uuid, uuid, text) to authenticated;

-- Reverse action -- a customer wrongly quarantined can be restored to
-- canonical status. Re-checks the uniqueness invariant explicitly
-- (rather than letting the index raise a raw constraint-violation
-- error) so the caller gets a clear message instead of a generic
-- Postgres error when un-quarantining would immediately collide with
-- another canonical customer on the same phone.
create or replace function public.unquarantine_customer(
  p_club_id uuid,
  p_customer_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_phone text;
  v_collision_id uuid;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select phone_e164 into v_phone from public.customers where id = p_customer_id and club_id = p_club_id;
  if v_phone is null and not found then
    raise exception 'customer not found';
  end if;

  if v_phone is not null then
    select id into v_collision_id from public.customers
      where club_id = p_club_id and phone_e164 = v_phone and duplicate_review_status = 'none' and id != p_customer_id
      limit 1;
    if v_collision_id is not null then
      raise exception 'cannot restore: another customer already holds this phone number as canonical';
    end if;
  end if;

  update public.customers set duplicate_review_status = 'none' where id = p_customer_id and club_id = p_club_id;

  perform public.write_audit_log(
    p_club_id, 'customer.unquarantined', 'customer', p_customer_id,
    jsonb_build_object('duplicate_review_status', 'quarantined_pending_review'),
    jsonb_build_object('duplicate_review_status', 'none'),
    null
  );
end;
$function$;

revoke execute on function public.unquarantine_customer(uuid, uuid) from public;
revoke execute on function public.unquarantine_customer(uuid, uuid) from anon;
grant execute on function public.unquarantine_customer(uuid, uuid) to authenticated;

-- 3. record_staff_whatsapp_consent now takes p_phone_e164 directly and
-- stores it on the consent row, so consent is permanently attributed
-- to the specific number it was actually recorded against -- not
-- re-derivable (and therefore not silently re-attributable) from
-- whatever the customer's phone_e164 happens to be later. Signature
-- is additive (new optional param appended at the end) so the 3
-- existing callers (CustomersPage, QuickBookingSheet, PlayersSection)
-- keep working unchanged until they're migrated to upsert_customer;
-- upsert_customer itself always passes it.
create or replace function public.record_staff_whatsapp_consent(
  p_club_id uuid,
  p_customer_id uuid,
  p_consented boolean,
  p_phone_display text,
  p_normalized_phone text,
  p_phone_e164 text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_existing record;
  v_was_previously_revoked boolean := false;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_consented is null then
    raise exception 'an explicit consent answer is required';
  end if;

  select * into v_existing from public.notification_consent
  where customer_id = p_customer_id and channel = 'whatsapp';

  -- Directive requirement: "staff cannot silently restore revoked
  -- consent through customer edit" -- and by extension, a consent
  -- decision recorded for a DIFFERENT phone number than the one on
  -- file now must never be treated as if it already answered for the
  -- current number. If the stored phone_e164 differs from the one
  -- this call is recording against, treat it as a fresh decision
  -- (not a "re-recorded after revoke" continuation) rather than
  -- silently carrying the old number's history onto the new number.
  if v_existing.id is not null and v_existing.revoked_at is not null
     and (v_existing.phone_e164 is null or p_phone_e164 is null or v_existing.phone_e164 = p_phone_e164) then
    v_was_previously_revoked := true;
  end if;

  insert into public.notification_consent (
    club_id, customer_id, channel, enabled, consent_source, consent_at, revoked_at,
    phone_display, normalized_phone, phone_e164
  ) values (
    p_club_id, p_customer_id, 'whatsapp', p_consented,
    case when p_consented then 'staff_recorded_customer_consent' else 'staff_recorded_customer_decline' end,
    case when p_consented then now() else null end,
    case when p_consented then null else now() end,
    p_phone_display, p_normalized_phone, p_phone_e164
  )
  on conflict (customer_id, channel) do update set
    enabled = p_consented,
    consent_source = case when p_consented then 'staff_recorded_customer_consent' else 'staff_recorded_customer_decline' end,
    consent_at = case when p_consented then now() else notification_consent.consent_at end,
    revoked_at = case when p_consented then null else now() end,
    phone_display = p_phone_display,
    normalized_phone = p_normalized_phone,
    phone_e164 = coalesce(p_phone_e164, notification_consent.phone_e164),
    updated_at = now();

  perform public.write_audit_log(
    p_club_id,
    case when v_was_previously_revoked and p_consented then 'whatsapp_consent.re_recorded_after_revoke'
         when p_consented then 'whatsapp_consent.recorded'
         else 'whatsapp_consent.declined' end,
    'customer', p_customer_id,
    jsonb_build_object('enabled', coalesce(v_existing.enabled, false), 'revoked_at', v_existing.revoked_at, 'phone_e164', v_existing.phone_e164),
    jsonb_build_object('enabled', p_consented, 'phone_e164', p_phone_e164),
    null
  );
end;
$function$;

-- upsert_customer now passes p_phone_e164 through to the consent RPC.
create or replace function public.upsert_customer(
  p_club_id uuid,
  p_full_name text,
  p_phone_e164 text,
  p_mobile_display text default null,
  p_email text default null,
  p_whatsapp_consent boolean default null,
  p_customer_id uuid default null
)
returns table(
  customer_id uuid,
  was_existing boolean,
  duplicate_of_customer_id uuid
)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_normalized_mobile text;
  v_existing_id uuid;
  v_result_id uuid;
  v_was_existing boolean := false;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_full_name is null or length(trim(p_full_name)) = 0 then
    raise exception 'name is required';
  end if;

  if p_phone_e164 is not null and p_phone_e164 !~ '^\+[1-9][0-9]{6,14}$' then
    raise exception 'invalid phone number';
  end if;

  v_normalized_mobile := case
    when p_mobile_display is not null then regexp_replace(regexp_replace(p_mobile_display, '\D', '', 'g'), '^0+', '')
    else null
  end;

  if p_customer_id is not null then
    if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.update', p_club_id)) then
      raise exception 'not authorized';
    end if;

    -- Cross-tenant guard: p_customer_id must actually belong to
    -- p_club_id, checked explicitly (not just relied upon via the
    -- final WHERE clause) so a cross-tenant id reliably returns
    -- "customer not found" rather than silently updating zero rows
    -- and still reporting success-shaped output.
    if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
      raise exception 'customer not found';
    end if;

    if p_phone_e164 is not null then
      select id into v_existing_id from public.customers
        where club_id = p_club_id and phone_e164 = p_phone_e164 and duplicate_review_status = 'none' and id != p_customer_id
        limit 1;
      if v_existing_id is not null then
        return query select p_customer_id, true, v_existing_id;
        return;
      end if;
    end if;

    update public.customers set
      full_name = trim(p_full_name),
      phone_e164 = coalesce(p_phone_e164, phone_e164),
      mobile_display = coalesce(p_mobile_display, mobile_display),
      normalized_mobile = coalesce(v_normalized_mobile, normalized_mobile),
      email = coalesce(p_email, email),
      updated_at = now()
    where id = p_customer_id and club_id = p_club_id
    returning id into v_result_id;
  else
    if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.create', p_club_id)) then
      raise exception 'not authorized';
    end if;

    -- Concurrency: two simultaneous creates for the same
    -- (club_id, phone_e164) must not both succeed as separate rows.
    -- The unique index is the actual guarantee (a second concurrent
    -- INSERT raises unique_violation, caught below and turned into
    -- "return the winner"); this SELECT is a fast-path only, not the
    -- correctness mechanism.
    if p_phone_e164 is not null then
      select id into v_existing_id from public.customers
        where club_id = p_club_id and phone_e164 = p_phone_e164 and duplicate_review_status = 'none'
        limit 1;
    end if;

    if v_existing_id is not null then
      v_result_id := v_existing_id;
      v_was_existing := true;
    else
      begin
        insert into public.customers (club_id, full_name, mobile_display, normalized_mobile, phone_e164, email, created_by)
        values (p_club_id, trim(p_full_name), p_mobile_display, v_normalized_mobile, p_phone_e164, p_email, auth.uid())
        returning id into v_result_id;
      exception when unique_violation then
        -- Lost a create-create race against a concurrent call for the
        -- exact same (club_id, phone_e164) -- the other transaction's
        -- row now exists; use it instead of erroring, so the caller
        -- still gets a single canonical customer back.
        select id into v_result_id from public.customers
          where club_id = p_club_id and phone_e164 = p_phone_e164 and duplicate_review_status = 'none'
          limit 1;
        v_was_existing := true;
      end;
    end if;
  end if;

  if p_whatsapp_consent is not null and p_phone_e164 is not null then
    perform public.record_staff_whatsapp_consent(p_club_id, v_result_id, p_whatsapp_consent, p_mobile_display, v_normalized_mobile, p_phone_e164);
  end if;

  return query select v_result_id, v_was_existing, null::uuid;
end;
$function$;
