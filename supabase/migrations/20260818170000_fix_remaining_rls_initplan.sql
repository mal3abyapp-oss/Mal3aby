-- FINAL PRODUCTION HARDENING pass: fixes the last 4 auth_rls_initplan
-- performance-advisor findings not caught by the earlier
-- gate12_rls_auth_uid_initplan_fix migration -- these 4 were added by
-- later customer-self-service migrations after that sweep ran, so they
-- never got the (select auth.uid()) wrapping.
--
-- Root cause (same pattern as gate12): a bare `auth.uid()` inside an
-- RLS policy expression is re-evaluated by the planner on EVERY ROW
-- scanned, not once per query. Wrapping it as `(select auth.uid())`
-- lets Postgres treat it as a stable sub-plan evaluated once and
-- reused -- semantically identical result, meaningfully cheaper at
-- scale on these specific tables (invoices and manual_payment_claims
-- are money-adjacent and will grow with every paid booking).
--
-- No behavior change: every policy below keeps the exact same
-- authorization logic, only the auth.uid() call sites are wrapped.

drop policy if exists invoices_self_service_select on public.invoices;
create policy invoices_self_service_select on public.invoices
  for select
  using (
    customer_id in (
      select c.id from public.customers c where c.user_id = (select auth.uid())
    )
  );

drop policy if exists payment_method_configs_select_customer_own_club on public.payment_method_configs;
create policy payment_method_configs_select_customer_own_club on public.payment_method_configs
  for select
  using (
    is_active = true
    and customer_visible = true
    and club_id in (
      select c.club_id from public.customers c where c.user_id = (select auth.uid())
    )
  );

drop policy if exists manual_payment_claims_self_service_insert on public.manual_payment_claims;
create policy manual_payment_claims_self_service_insert on public.manual_payment_claims
  for insert
  with check (
    claimed_by = (select auth.uid())
    and invoice_id in (
      select i.id
      from public.invoices i
      join public.customers c on c.id = i.customer_id
      where c.user_id = (select auth.uid())
    )
  );

drop policy if exists manual_payment_claims_self_service_select on public.manual_payment_claims;
create policy manual_payment_claims_self_service_select on public.manual_payment_claims
  for select
  using (claimed_by = (select auth.uid()));

comment on policy invoices_self_service_select on public.invoices is
  'Final production hardening pass: auth.uid() wrapped in (select ...) to avoid per-row re-evaluation (auth_rls_initplan advisor finding). Same authorization logic as before.';
comment on policy payment_method_configs_select_customer_own_club on public.payment_method_configs is
  'Final production hardening pass: auth.uid() wrapped in (select ...) to avoid per-row re-evaluation (auth_rls_initplan advisor finding). Same authorization logic as before.';
comment on policy manual_payment_claims_self_service_insert on public.manual_payment_claims is
  'Final production hardening pass: auth.uid() wrapped in (select ...) to avoid per-row re-evaluation (auth_rls_initplan advisor finding). Same authorization logic as before.';
comment on policy manual_payment_claims_self_service_select on public.manual_payment_claims is
  'Final production hardening pass: auth.uid() wrapped in (select ...) to avoid per-row re-evaluation (auth_rls_initplan advisor finding). Same authorization logic as before.';
