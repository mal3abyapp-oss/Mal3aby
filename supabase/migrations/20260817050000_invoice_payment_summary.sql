-- Master Payment Directive Phase 4 (task #81): single financial source
-- of truth for invoice payment status.
--
-- Audit finding (D-015 in AUTONOMOUS_DECISION_LOG.md): the correct
-- outstanding-balance formula (total - allocated payments + completed
-- refunds, established in Gate 11's outstanding_invoices view) was
-- independently reimplemented client-side in 5 places, 4 of them
-- WRONG (missing the refund-netting term): BookingDetailSheet.tsx,
-- BillingPage.tsx, AcademyOverview.tsx, PlayerStatusPanel.tsx,
-- CustomerDetailDialog.tsx. This is a real, currently-live financial
-- drift bug -- a booking paid in full then partially refunded shows a
-- too-low outstanding balance on 4 of 5 screens that touch it.
--
-- Fix: one canonical function every screen migrates to, instead of
-- each screen re-deriving the math (Part II Section 16: REUSE ->
-- EXTEND -> NORMALIZE, never DUPLICATE). security invoker (the
-- default for LANGUAGE sql functions) so it inherits the caller's
-- existing RLS on invoices/payment_allocations/refunds/payments,
-- exactly like outstanding_invoices already does -- no new privilege
-- surface introduced.
--
-- Unlike outstanding_invoices (which only covers status='issued'
-- invoices, correct for an "outstanding balance" report), this
-- function covers ALL invoices including draft/void, since every
-- screen needs a payment_status answer, not just the collections
-- report.
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
as $$
  select
    i.id as invoice_id,
    i.total,
    coalesce(alloc.paid_amount, 0) as paid,
    coalesce(alloc.refunded_amount, 0) as refunded,
    case
      when i.status = 'void' then 0
      else greatest(i.total - coalesce(alloc.paid_amount, 0) + coalesce(alloc.refunded_amount, 0), 0)
    end as outstanding,
    case
      when i.status = 'void' then 'void'
      when i.status = 'draft' then 'draft'
      -- Fully refunded: every allocated payment on this invoice has
      -- been completely refunded, and something was actually paid.
      when coalesce(alloc.paid_amount, 0) > 0
           and coalesce(alloc.refunded_amount, 0) >= coalesce(alloc.paid_amount, 0)
        then 'refunded'
      -- Partially refunded: some refund happened but net paid hasn't
      -- dropped to zero (Section 24 -- don't misleadingly revert to
      -- unpaid when the reality is paid-then-partially-refunded,
      -- whether or not the remaining net still covers the total).
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
       where pa.invoice_id = i.id) as refunded_amount
  ) alloc on true
  where i.id = any(p_invoice_ids);
$$;

grant execute on function public.get_invoice_payment_summary(uuid[]) to authenticated;

comment on function public.get_invoice_payment_summary(uuid[]) is
  'Master Payment Directive task #81: single source of truth for invoice payment status (unpaid/partially_paid/paid/partially_refunded/refunded/draft/void), reusing outstanding_invoices'' exact paid/refunded formula but covering all invoice statuses, not just issued. security invoker -- relies entirely on the caller''s existing RLS on invoices/payment_allocations/refunds, same as outstanding_invoices.';
