-- FINANCIAL INTEGRITY & RECONCILIATION ACCEPTANCE (Stage A, 2026-08-30):
-- outstanding still double-counted a REAL, exploitable amount for a
-- Shop sale with a PARTIAL return -- the 2026-08-30 fix only handled
-- the fully-refunded case (refunded >= paid -> outstanding forced to
-- 0). A partial Shop return fell through to the original formula
-- (total - paid + refunded) unchanged.
--
-- Reproduced live: sold 2 items (280 EGP net of a 20 EGP discount,
-- paid in full, cash) via create_shop_sale(), then returned 1 item
-- through return_shop_sale() with a full 140 EGP refund for that item
-- (its exact economic value -- confirmed via shop_sale_items.net_line_total).
-- get_invoice_payment_summary() reported outstanding = 280 - 280 + 140
-- = 140.00 -- as if the customer still owed 140 EGP for an item they
-- had already returned and been refunded for in full.
--
-- This was not cosmetic: BillingPage's "Record payment" section shows
-- for ANY invoice with outstanding > 0, and record_payment() accepts
-- any amount up to that same outstanding figure. Live-tested and
-- CONFIRMED EXPLOITABLE: successfully recorded a second real 140 EGP
-- payment against this already-fully-settled, already-returned sale
-- via record_payment() (immediately reverted -- this was a proof, not
-- a real charge). A club could genuinely double-collect for returned
-- merchandise.
--
-- ROOT CAUSE, and why this is NOT the same fix as "force outstanding
-- to 0 on full refund": a real booking partial refund (a discretionary
-- goodwill refund on a still-valid, still-delivered service -- e.g. a
-- partial refund for a service issue on a booking that still went
-- ahead) is DOCUMENTED, TESTED, and INTENTIONAL as "outstanding
-- re-opens by the refunded amount" -- see docs/PROJECT_STATE.md's own
-- accepted test scenario: total 500, paid 200, refunded 50 ->
-- outstanding 350, confirmed correct at the time. That semantic is
-- UNTOUCHED by this migration and must never be forced to match Shop's.
--
-- A Shop return is different in kind, not degree: the customer
-- physically gives back goods already fully paid for, and the refund
-- IS the settlement of that specific returned value -- there is no
-- remaining service or goods left to "still be owed" for the returned
-- portion. invoices.total is deliberately never rewritten on a return
-- (no destructive rewrite of financial history, confirmed: no RPC
-- reduces invoices.total for a refund/return), so the ONLY correct fix
-- is to identify, per-refund, which refunds are return-driven (i.e.
-- linked to a real shop_sale_returns row via
-- shop_sale_returns.refund_payment_id = refunds.id -- that column is
-- misleadingly named but holds the refund's own id, confirmed by
-- reading return_shop_sale()'s source) and exclude ONLY that portion
-- from the "refunded" term that re-opens outstanding. Refunds NOT
-- linked to a return (booking/membership goodwill refunds) continue to
-- use the exact original formula, unchanged.
--
-- Validated against every real partially-refunded invoice on the
-- platform before writing this fix (13 rows): every return-driven
-- case correctly drops to outstanding = 0; the one real booking
-- goodwill-refund case (total 220, paid 220, refunded 50, not linked
-- to any shop_sale_returns row) is UNCHANGED at outstanding = 50,
-- exactly matching the documented/tested booking semantic.
create or replace function public.get_invoice_payment_summary(p_invoice_ids uuid[])
returns table (
  invoice_id uuid,
  total numeric,
  paid numeric,
  refunded numeric,
  outstanding numeric,
  payment_status text
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select
    i.id as invoice_id,
    i.total,
    coalesce(alloc.paid_amount, 0) as paid,
    coalesce(alloc.refunded_amount, 0) as refunded,
    case
      when i.status = 'void' then 0
      -- Fully refunded (any mix of return-driven and goodwill): the
      -- invoice's payments have been completely unwound, so nothing is
      -- outstanding regardless of total. Unchanged from the prior fix.
      when coalesce(alloc.paid_amount, 0) > 0
           and coalesce(alloc.refunded_amount, 0) >= coalesce(alloc.paid_amount, 0)
        then 0
      -- Partial refund: re-open outstanding only by the portion of the
      -- refund that is NOT return-driven (goodwill/booking-style). A
      -- Shop return's refund settles the returned goods themselves --
      -- it must never re-open a collectible balance for value already
      -- given back.
      else greatest(
        i.total - coalesce(alloc.paid_amount, 0) + coalesce(alloc.non_return_refunded_amount, 0),
        0
      )
    end as outstanding,
    case
      when i.status = 'void' then 'void'
      when i.status = 'draft' then 'draft'
      when coalesce(alloc.paid_amount, 0) > 0
           and coalesce(alloc.refunded_amount, 0) >= coalesce(alloc.paid_amount, 0)
        then 'refunded'
      when coalesce(alloc.refunded_amount, 0) > 0
        then 'partially_refunded'
      when coalesce(alloc.paid_amount, 0) <= 0 then 'unpaid'
      when coalesce(alloc.paid_amount, 0) >= i.total then 'paid'
      else 'partially_paid'
    end as payment_status
  from public.invoices i
  left join lateral (
    select
      (select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = i.id) as paid_amount,
      (select sum(r.amount)
       from public.payment_allocations pa
       join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
       where pa.invoice_id = i.id) as refunded_amount,
      -- Refunded amount attributable ONLY to refunds NOT linked to a
      -- Shop return -- i.e. the portion that legitimately re-opens
      -- outstanding under the documented booking/membership semantic.
      (select sum(r.amount)
       from public.payment_allocations pa
       join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
       where pa.invoice_id = i.id
         and not exists (
           select 1 from public.shop_sale_returns ssr where ssr.refund_payment_id = r.id
         )) as non_return_refunded_amount
  ) alloc on true
  where i.id = any(p_invoice_ids);
$$;

comment on function public.get_invoice_payment_summary(uuid[]) is
  'Master Payment Directive task #81: single source of truth for invoice payment status. Fixed 2026-08-30 (financial integrity acceptance, round 2): a Shop return''s refund no longer re-opens outstanding -- only re-opened by refunds NOT linked to a shop_sale_returns row (booking/membership-style goodwill refunds on a still-valid, still-delivered service, per the documented/tested booking semantic in docs/PROJECT_STATE.md). Fully-refunded invoices (any refund mix) remain outstanding = 0, unchanged from the prior 2026-08-30 fix. security invoker -- relies entirely on the caller''s existing RLS on invoices/payment_allocations/refunds/shop_sale_returns, same as outstanding_invoices.';

-- Same fix applied to outstanding_invoices, the collections-report view
-- that shares this exact formula (per its own header comment).
create or replace view public.outstanding_invoices
  with (security_invoker = true)
as
select
  i.id,
  i.club_id,
  i.branch_id,
  i.invoice_number,
  i.customer_id,
  c.full_name as customer_name,
  c.normalized_mobile,
  i.status,
  i.total,
  i.due_date,
  i.issued_at,
  case
    when coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0) > 0
         and coalesce((
           select sum(r.amount) from payment_allocations pa
           join refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
           where pa.invoice_id = i.id
         ), 0) >= coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0)
      then 0
    else greatest(
      i.total
        - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0)
        + coalesce((
            select sum(r.amount) from payment_allocations pa
            join refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
            where pa.invoice_id = i.id
              and not exists (
                select 1 from shop_sale_returns ssr where ssr.refund_payment_id = r.id
              )
          ), 0),
      0
    )
  end as outstanding,
  case
    when i.due_date is not null then current_date - i.due_date
    else null
  end as days_overdue
from invoices i
join customers c on c.id = i.customer_id
where i.status = 'issued';

-- record_payment()'s own independent outstanding calc (used to cap how
-- much a NEW payment can be for) shares this exact same bug -- it must
-- be fixed too, or the double-collection exploit remains live even
-- though the DISPLAYED outstanding is now correct. This is the
-- concrete mechanism that was live-tested and confirmed exploitable.
create or replace function public.record_payment(p_invoice_id uuid, p_amount numeric, p_method text, p_reference text DEFAULT NULL::text, p_idempotency_key uuid DEFAULT NULL::uuid, p_official_receipt_id uuid DEFAULT NULL::uuid)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_invoice record;
  v_payment_id uuid;
  v_existing_payment_id uuid;
  v_pending_subscription_id uuid;
  v_pending_membership_id uuid;
  v_outstanding numeric;
  v_event_id uuid;
  v_new_outstanding numeric;
  v_pending_booking_id uuid;
  v_club_name text;
  v_customer_name text;
  v_booking_ref text;
  v_invoice_token text;
  v_booking_field_id uuid;
  v_booking_branch_id uuid;
  v_booking_status text;
  v_effective_policy public.government_collection_policies;
  v_receipt public.official_collection_receipts%rowtype;
  v_receipt_validated boolean := false;
  v_has_custody boolean;
  v_active_shift_id uuid;
  v_academy_player_name text;
  v_academy_group_name text;
  v_academy_subscription_id uuid;
  v_academy_start_date date;
  v_academy_end_date date;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;

  if p_method not in ('cash', 'card', 'bank_transfer', 'wallet', 'other') then
    raise exception 'invalid method';
  end if;

  select * into v_invoice
  from public.invoices
  where id = p_invoice_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.create', club_id);

  if v_invoice is null then
    raise exception 'invoice not found or you do not have permission to record a payment against it';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing_payment_id
    from public.payments
    where club_id = v_invoice.club_id and idempotency_key = p_idempotency_key;

    if v_existing_payment_id is not null then
      return v_existing_payment_id;
    end if;
  end if;

  if not public.club_write_allowed(v_invoice.club_id, 'settle_existing') then
    raise exception 'club subscription does not allow settling existing balances';
  end if;

  perform 1 from public.invoices where id = p_invoice_id for update;

  select status into v_invoice.status from public.invoices where id = p_invoice_id;

  if v_invoice.status != 'issued' then
    raise exception 'can only record payment against an issued invoice';
  end if;

  select status into v_booking_status from public.bookings where invoice_id = p_invoice_id limit 1;
  if v_booking_status in ('cancelled', 'no_show') then
    raise exception 'this booking was % -- payment can no longer be recorded against it', v_booking_status;
  end if;

  select b.field_id, b.branch_id into v_booking_field_id, v_booking_branch_id
  from public.bookings b where b.invoice_id = p_invoice_id limit 1;

  if v_booking_branch_id is null then
    select g.branch_id into v_booking_branch_id
    from public.subscriptions s
    join public.enrollments e on e.id = s.enrollment_id
    join public.groups g on g.id = e.group_id
    where s.invoice_id = p_invoice_id
    limit 1;
  end if;

  if v_booking_branch_id is null then
    select cms.branch_id into v_booking_branch_id
    from public.club_membership_subscriptions cms
    where cms.invoice_id = p_invoice_id
    limit 1;
  end if;

  if p_method = 'cash' then
    select coalesce(bool_or(has_cash_custody), false) into v_has_custody
    from public.club_memberships
    where user_id = auth.uid() and club_id = v_invoice.club_id and status = 'active';

    if v_has_custody then
      if v_booking_branch_id is null then
        raise exception 'cash collection requires a branch-scoped booking -- this invoice has none';
      end if;

      select id into v_active_shift_id
      from public.cash_shifts
      where branch_id = v_booking_branch_id and opened_by = auth.uid() and status = 'open';

      if v_active_shift_id is null then
        raise exception 'cash collection requires an active cash shift -- open one before collecting cash';
      end if;
    end if;
  end if;

  v_effective_policy := public.get_effective_government_policy(
    v_invoice.club_id, v_booking_branch_id, v_booking_field_id
  );

  if v_effective_policy.enabled
     and v_effective_policy.official_receipt_required
     and p_method = any(v_effective_policy.required_payment_methods)
  then
    if p_official_receipt_id is null then
      raise exception 'official collection receipt required: this club/field requires an official government collection receipt for % payments' , p_method;
    end if;

    select * into v_receipt from public.official_collection_receipts
    where id = p_official_receipt_id and club_id = v_invoice.club_id and status = 'active';

    if v_receipt is null then
      raise exception 'official collection receipt not found, not active, or does not belong to this club';
    end if;
    v_receipt_validated := true;

    if v_receipt.payment_id is not null then
      raise exception 'this official collection receipt is already linked to a payment';
    end if;

    if v_receipt.receipt_amount != p_amount then
      raise exception 'official collection receipt amount (%) does not match the payment amount (%)', v_receipt.receipt_amount, p_amount;
    end if;
  end if;

  -- FIX (financial integrity acceptance, round 2): the outstanding
  -- cap a new payment is validated against must use the SAME
  -- return-aware formula as get_invoice_payment_summary(), or a
  -- Shop sale with a partial return remains double-collectible even
  -- after the displayed "outstanding" figure is corrected. See this
  -- migration's header for the live-confirmed exploit and the exact
  -- reasoning for excluding only return-driven refunds.
  select case
    when coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = v_invoice.id), 0) > 0
         and coalesce((select sum(r.amount) from public.payment_allocations pa
                       join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
                       where pa.invoice_id = v_invoice.id), 0)
           >= coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = v_invoice.id), 0)
      then 0
    else greatest(
      v_invoice.total
        - coalesce((select sum(pa.amount) from public.payment_allocations pa where pa.invoice_id = v_invoice.id), 0)
        + coalesce((select sum(r.amount) from public.payment_allocations pa
                    join public.refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
                    where pa.invoice_id = v_invoice.id
                      and not exists (select 1 from public.shop_sale_returns ssr where ssr.refund_payment_id = r.id)), 0),
      0
    )
  end
  into v_outstanding;

  if p_amount > v_outstanding then
    raise exception 'payment amount (%) exceeds the invoice''s outstanding balance (%)', p_amount, v_outstanding;
  end if;

  insert into public.payments (club_id, branch_id, customer_id, method, amount, reference, received_by, idempotency_key, cash_shift_id)
  values (v_invoice.club_id, v_invoice.branch_id, v_invoice.customer_id, p_method, p_amount, p_reference, auth.uid(), p_idempotency_key, v_active_shift_id)
  returning id into v_payment_id;

  if v_receipt_validated then
    update public.official_collection_receipts
    set payment_id = v_payment_id, invoice_id = p_invoice_id,
        customer_id = v_invoice.customer_id, updated_at = now()
    where id = p_official_receipt_id;

    perform public.write_audit_log(
      v_invoice.club_id, 'official_collection_receipt.created', 'official_collection_receipt', p_official_receipt_id,
      null,
      jsonb_build_object('payment_id', v_payment_id, 'receipt_serial', v_receipt.receipt_serial, 'amount', p_amount),
      null
    );
  end if;

  perform public.write_audit_log(
    v_invoice.club_id, 'payment.record', 'payment', v_payment_id, null,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'invoice_id', p_invoice_id, 'official_receipt_id', p_official_receipt_id, 'cash_shift_id', v_active_shift_id),
    null
  );

  insert into public.payment_allocations (payment_id, invoice_id, amount)
  values (v_payment_id, p_invoice_id, p_amount);

  select id into v_pending_subscription_id from public.subscriptions
  where invoice_id = p_invoice_id and status = 'pending'
  limit 1;

  if v_pending_subscription_id is not null then
    perform public._activate_subscription_if_due_internal(v_pending_subscription_id);
  end if;

  select id into v_pending_membership_id from public.club_membership_subscriptions
  where invoice_id = p_invoice_id and status = 'pending_payment'
  limit 1;

  if v_pending_membership_id is not null then
    perform public._activate_club_membership_if_due_internal(v_pending_membership_id);
  end if;

  v_new_outstanding := greatest(v_outstanding - p_amount, 0);

  if v_new_outstanding <= 0 then
    select id into v_pending_booking_id from public.bookings
    where invoice_id = p_invoice_id and status = 'pending_payment'
    limit 1;

    if v_pending_booking_id is not null then
      update public.bookings set status = 'confirmed' where id = v_pending_booking_id and status = 'pending_payment';

      if v_receipt_validated then
        update public.official_collection_receipts
        set booking_id = v_pending_booking_id
        where id = p_official_receipt_id and booking_id is null;
      end if;

      perform public.write_audit_log(
        v_invoice.club_id, 'booking.auto_confirmed_on_full_payment', 'bookings', v_pending_booking_id, null,
        jsonb_build_object('invoice_id', p_invoice_id, 'triggering_payment_id', v_payment_id),
        null
      );
    end if;
  end if;

  select name into v_club_name from public.clubs where id = v_invoice.club_id;
  select full_name into v_customer_name from public.customers where id = v_invoice.customer_id;
  select 'MB-' || upper(substring(id::text, 1, 8)) into v_booking_ref
    from public.bookings where invoice_id = p_invoice_id limit 1;

  v_invoice_token := public._mint_invoice_token_internal(p_invoice_id, v_invoice.club_id, auth.uid());

  select s.id, p.full_name, g.name, s.start_date, s.end_date
    into v_academy_subscription_id, v_academy_player_name, v_academy_group_name, v_academy_start_date, v_academy_end_date
  from public.subscriptions s
  join public.enrollments e on e.id = s.enrollment_id
  join public.players p on p.id = e.player_id
  join public.groups g on g.id = e.group_id
  where s.invoice_id = p_invoice_id
  limit 1;

  v_event_id := public.emit_notification_event(
    v_invoice.club_id, 'payment.received', 'payment', v_payment_id,
    jsonb_build_object('amount', p_amount, 'method', p_method, 'customer_id', v_invoice.customer_id, 'invoice_id', p_invoice_id, 'remaining_outstanding', v_new_outstanding)
  );

  if v_academy_subscription_id is not null then
    perform public.queue_whatsapp_notification(
      v_invoice.club_id, v_event_id, v_invoice.customer_id, 'academy-payment-received', 'payment_confirmations',
      jsonb_build_object(
        'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
        'payment_status', case when v_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
        'remaining_outstanding', v_new_outstanding, 'method', p_method,
        'club_name', v_club_name, 'customer_name', v_customer_name,
        'player_name', v_academy_player_name, 'group_name', v_academy_group_name,
        'subscription_start_date', v_academy_start_date, 'subscription_end_date', v_academy_end_date,
        'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id,
        'receipt_serial', case when v_receipt_validated then v_receipt.receipt_serial else null end,
        'receipt_book', case when v_receipt_validated then v_receipt.receipt_book else null end,
        'receipt_series', case when v_receipt_validated then v_receipt.receipt_series else null end,
        'receipt_date', case when v_receipt_validated then v_receipt.receipt_date else null end
      ),
      'transactional', 'payment.received:' || v_payment_id::text,
      'document', 'invoice_pdf'
    );
    perform public.queue_email_notification(
      v_invoice.club_id, v_event_id, v_invoice.customer_id, 'academy-payment-received', 'payment_confirmations',
      jsonb_build_object(
        'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
        'payment_status', case when v_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
        'remaining_outstanding', v_new_outstanding, 'method', p_method,
        'club_name', v_club_name, 'customer_name', v_customer_name,
        'player_name', v_academy_player_name, 'group_name', v_academy_group_name,
        'subscription_start_date', v_academy_start_date, 'subscription_end_date', v_academy_end_date,
        'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id,
        'receipt_serial', case when v_receipt_validated then v_receipt.receipt_serial else null end,
        'receipt_book', case when v_receipt_validated then v_receipt.receipt_book else null end,
        'receipt_series', case when v_receipt_validated then v_receipt.receipt_series else null end,
        'receipt_date', case when v_receipt_validated then v_receipt.receipt_date else null end
      ),
      'transactional', 'payment.received:' || v_payment_id::text
    );
  else
    perform public.queue_whatsapp_notification(
      v_invoice.club_id, v_event_id, v_invoice.customer_id, 'payment-received', 'payment_confirmations',
      jsonb_build_object(
        'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
        'payment_status', case when v_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
        'remaining_outstanding', v_new_outstanding, 'method', p_method,
        'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
        'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id,
        'receipt_serial', case when v_receipt_validated then v_receipt.receipt_serial else null end,
        'receipt_book', case when v_receipt_validated then v_receipt.receipt_book else null end,
        'receipt_series', case when v_receipt_validated then v_receipt.receipt_series else null end,
        'receipt_date', case when v_receipt_validated then v_receipt.receipt_date else null end
      ),
      'transactional', 'payment.received:' || v_payment_id::text,
      'document', 'invoice_pdf'
    );
    perform public.queue_email_notification(
      v_invoice.club_id, v_event_id, v_invoice.customer_id, 'payment-received', 'payment_confirmations',
      jsonb_build_object(
        'amount', p_amount, 'invoice_number', v_invoice.invoice_number,
        'payment_status', case when v_new_outstanding <= 0 then 'paid' else 'partially_paid' end,
        'remaining_outstanding', v_new_outstanding, 'method', p_method,
        'club_name', v_club_name, 'customer_name', v_customer_name, 'booking_ref', v_booking_ref,
        'invoice_token', v_invoice_token, 'invoice_id', p_invoice_id,
        'receipt_serial', case when v_receipt_validated then v_receipt.receipt_serial else null end,
        'receipt_book', case when v_receipt_validated then v_receipt.receipt_book else null end,
        'receipt_series', case when v_receipt_validated then v_receipt.receipt_series else null end,
        'receipt_date', case when v_receipt_validated then v_receipt.receipt_date else null end
      ),
      'transactional', 'payment.received:' || v_payment_id::text
    );
  end if;

  return v_payment_id;
end;
$function$;

-- FINANCIAL INTEGRITY & RECONCILIATION ACCEPTANCE (Stage A, A11 gateway
-- safety, 2026-08-30): defense-in-depth column-grant hardening found
-- during this pass's live review of club_gateway_connections.
--
-- secret_vault_id / webhook_secret_vault_id hold Supabase Vault OBJECT
-- IDs (never the decrypted secret values themselves -- decryption is
-- service_role-only, confirmed via vault.decrypted_secrets grants).
-- list_club_gateway_connections() correctly redacts these to a boolean
-- has_secret and is SECURITY DEFINER, so it does not need (and never
-- used) the caller's own column grant.
--
-- However, information_schema.column_privileges confirmed a direct
-- SELECT grant to `authenticated` on both raw columns, with the
-- table's RLS SELECT policy gated only on the ordinary
-- payment.methods.view permission (held by many ordinary staff roles,
-- not just owners). Any staff member with that permission could read
-- the raw Vault object IDs directly via PostgREST
-- (`select secret_vault_id, webhook_secret_vault_id from
-- club_gateway_connections`), bypassing the redacting RPC entirely.
-- No live connection currently has non-null values here and Vault
-- decryption itself remains service_role-only, so this was metadata
-- exposure, not a live secret leak -- but it defeats the purpose of
-- the redacting RPC and narrows the attack surface for anyone who
-- later gains broader Vault read access. grep-confirmed no frontend
-- code path selects either column directly (only descriptive
-- comments) -- revoking is safe and does not break
-- list_club_gateway_connections (SECURITY DEFINER, unaffected by the
-- caller's own grants).
revoke select (secret_vault_id, webhook_secret_vault_id) on public.club_gateway_connections from authenticated;
