-- QA sweep (2026-08-30): Shop POS return regression on the shared
-- outstanding-balance formula.
--
-- Reproduced live: sold a 150.00 EGP item (invoice issued, fully paid
-- via cash), then processed a full return with a full refund through
-- Sales & Returns. return_shop_sale() correctly restocks the item,
-- creates a completed refunds row, and moves shop_sales.status to
-- 'returned' -- but (by design; see return_shop_sale's own header)
-- never touches invoices.status, since a return is a distinct concept
-- from voiding the invoice itself.
--
-- get_invoice_payment_summary() (and outstanding_invoices, which
-- shares its formula) computes:
--   outstanding = greatest(total - paid + refunded, 0)
-- For this invoice: 150 - 150 + 150 = 150 -- the fully-refunded sale
-- shows as 150.00 EGP outstanding on Billing & Payments, inflating
-- "Total outstanding" and miscounting "Customers with dues", even
-- though the customer was fully refunded and owes nothing.
--
-- The formula's refund-netting term is correct for its original
-- purpose (Master Payment Directive task #81 / D-015): a partial
-- goodwill refund on a still-valid, still-owed invoice (e.g. a
-- booking) genuinely should re-open the outstanding balance by the
-- refunded amount, since the customer still owes for the un-refunded
-- portion of the same service. That case is unaffected by this fix.
--
-- What the formula got wrong is the case this function's own
-- payment_status branch already recognizes correctly: once
-- refunded_amount >= paid_amount, the invoice is fully 'refunded' --
-- nothing further is owed on it. outstanding must be 0 in that case,
-- not total - paid + refunded (which double-counts the refund against
-- an invoice whose payments have already been fully unwound).
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
      -- Fully refunded: the invoice's payments have been completely
      -- unwound, so nothing is outstanding regardless of total.
      when coalesce(alloc.paid_amount, 0) > 0
           and coalesce(alloc.refunded_amount, 0) >= coalesce(alloc.paid_amount, 0)
        then 0
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

comment on function public.get_invoice_payment_summary(uuid[]) is
  'Master Payment Directive task #81: single source of truth for invoice payment status (unpaid/partially_paid/paid/partially_refunded/refunded/draft/void), reusing outstanding_invoices'' paid/refunded formula but covering all invoice statuses, not just issued. Fixed 2026-08-30 (QA sweep): outstanding is forced to 0 once refunded_amount >= paid_amount (fully refunded), instead of double-counting the refund back into the balance -- see this migration''s header for the reproduction (a fully-returned Shop POS sale). security invoker -- relies entirely on the caller''s existing RLS on invoices/payment_allocations/refunds, same as outstanding_invoices.';

-- Same fix applied to outstanding_invoices, the collections-report
-- view get_invoice_payment_summary's own header says it reuses the
-- formula from -- it has the identical bug for the identical reason.
-- security_invoker=true re-specified explicitly (not just relying on
-- CREATE OR REPLACE VIEW to carry it forward): the view must keep
-- running under the querying user's own RLS, exactly as it did
-- before this migration -- dropping that option here would be a
-- privilege-boundary regression, not just a formula fix.
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
    else i.total
      - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id), 0)
      + coalesce((
          select sum(r.amount) from payment_allocations pa
          join refunds r on r.payment_id = pa.payment_id and r.status = 'completed'
          where pa.invoice_id = i.id
        ), 0)
  end as outstanding,
  case
    when i.due_date is not null then current_date - i.due_date
    else null
  end as days_overdue
from invoices i
join customers c on c.id = i.customer_id
where i.status = 'issued';
