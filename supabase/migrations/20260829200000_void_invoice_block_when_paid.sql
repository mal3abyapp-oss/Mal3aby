-- SAAS ACCEPTANCE REVIEW -- financial arithmetic audit finding DB-2
-- (2026-08-29): void_invoice() unconditionally flips an invoice's
-- status: issued -> void with zero check for existing payment
-- allocations. Live-reproduced on a disposable TEST-CLUB-2 fixture
-- (fully cleaned up): a fully-paid invoice (100.00 collected, fully
-- allocated) was voided successfully, leaving the real cash payment
-- dangling -- not refunded, not reallocated, no audit note about the
-- collision. get_invoice_payment_summary() then reports
-- outstanding=0 for the void invoice, which reads as "resolved" and
-- masks the real state: a real customer payment with no valid
-- invoice explaining what it was for.
--
-- Contrast: the *other* invoice-voiding code path in this codebase,
-- expire_stale_booking_holds(), already does this correctly -- it
-- only auto-voids an invoice when sum(payment_allocations.amount) = 0.
-- void_invoice() was the one inconsistent, unsafe path, callable by
-- any staff member holding invoice.update.
--
-- Fix: block the void outright when the invoice has any payment
-- allocation recorded against it, with a clear message directing
-- staff to refund first. This is the safe, conservative choice --
-- it does not attempt to guess whether an auto-refund/auto-reversal
-- is the intended product behavior (that would be a business-logic
-- decision outside this review's scope), it simply closes the gap
-- that let real money go untracked.
create or replace function public.void_invoice(p_invoice_id uuid, p_reason text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_allocated numeric;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a void reason is required';
  end if;

  select club_id into v_club_id
  from public.invoices
  where id = p_invoice_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('invoice.update', club_id);

  if v_club_id is null then
    raise exception 'invoice not found or you do not have permission to void it';
  end if;

  select coalesce(sum(amount), 0) into v_allocated
  from public.payment_allocations
  where invoice_id = p_invoice_id;

  if v_allocated > 0 then
    raise exception 'cannot void an invoice with recorded payments -- refund the payment(s) first, then void';
  end if;

  update public.invoices set status = 'void' where id = p_invoice_id and status = 'issued';

  if not found then
    raise exception 'invoice not found or not in a voidable state';
  end if;

  perform public.write_audit_log(v_club_id, 'void_invoice', 'invoices', p_invoice_id, null, jsonb_build_object('status', 'void'), p_reason);
end;
$function$;
