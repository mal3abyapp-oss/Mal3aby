-- Master Payment Directive Section 86 ("My Payments / My Invoices"):
-- a customer must be able to see their own unpaid/partial/paid
-- invoices, payment history, and outstanding balance in the portal.
--
-- Audit finding while building task #83: invoices had NO self-service
-- SELECT policy at all -- only invoices_select_club_staff (permission-
-- gated staff access) and invoices_platform_owner_select existed. A
-- logged-in customer could not read their own invoice rows, which
-- blocks the portal payments page (and the manual_payment_claims
-- self-service insert policy's own subquery, which reads invoices to
-- verify ownership -- that subquery runs as the SECURITY DEFINER
-- function owner in claim_manual_payment(), so it wasn't blocked, but
-- a plain client-side .from('invoices') select for the customer UI
-- would be).
create policy "invoices_self_service_select" on public.invoices
  for select using (
    customer_id in (select c.id from public.customers c where c.user_id = auth.uid())
  );

comment on policy "invoices_self_service_select" on public.invoices is
  'Master Payment Directive Section 86: a customer may read their own invoices (any status) for the portal My Payments page.';

-- Section 73/86: itemized payment history on the customer's own
-- invoices (method/amount/date/reference), not just the aggregate
-- outstanding figure.
create policy "payment_allocations_self_service_select" on public.payment_allocations
  for select using (
    invoice_id in (
      select i.id from public.invoices i
      join public.customers c on c.id = i.customer_id
      where c.user_id = auth.uid()
    )
  );

create policy "payments_self_service_select" on public.payments
  for select using (
    id in (
      select pa.payment_id from public.payment_allocations pa
      join public.invoices i on i.id = pa.invoice_id
      join public.customers c on c.id = i.customer_id
      where c.user_id = auth.uid()
    )
  );

comment on policy "payments_self_service_select" on public.payments is
  'Master Payment Directive Section 73/86: a customer may read the payment rows allocated to their own invoices (method/amount/date/reference) for the portal payment history.';
