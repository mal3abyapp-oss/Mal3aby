-- Directive section 29/42/43: surface compliance exceptions to
-- authorized users. The hard block in record_payment() makes a
-- "payment recorded without a required receipt" structurally
-- impossible going forward, but this reconciliation check gives
-- authorized users a defensive, honest view that the count is
-- actually zero (or flags it immediately if it's ever not), rather
-- than only asserting it in a report. Kept minimal and reusing the
-- existing report/RLS/permission pattern -- no new dashboard.
--
-- Note: this function's final form (below) already includes the
-- effective_from time-boundary fix found during acceptance testing --
-- an earlier draft compared ALL historical payments against the
-- CURRENT policy with no time boundary, which incorrectly flagged
-- payments recorded before compliance was ever enabled for that club
-- (a violation of the directive's own no-retroactive-enforcement rule,
-- sections 36-38). Verified live: a club with 23 pre-existing cash
-- payments predating its policy-enable timestamp went from an
-- incorrect count of 23 down to the correct count of 0 (plus any
-- genuinely-missing-receipt payment recorded after the policy went
-- live) once this boundary was added.
create or replace function public.get_government_compliance_exceptions(p_club_id uuid)
returns table(
  missing_receipt_payment_count bigint,
  reversed_awaiting_review_count bigint
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('payment.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  return query
  select
    -- Payments made under this club, on a method/scope that currently
    -- requires a receipt, that have no linked active official receipt.
    -- Resolved against the CURRENT effective policy (a reconciliation
    -- signal, not a retroactive re-judgement of past payments -- see
    -- directive section 36-38), and bounded to payments received at or
    -- after the effective policy's effective_from so pre-existing
    -- payments are never retroactively flagged.
    (
      select count(*)
      from public.payments pm
      join public.invoices inv on inv.id = (
        select pa.invoice_id from public.payment_allocations pa where pa.payment_id = pm.id limit 1
      )
      left join public.bookings bk on bk.invoice_id = inv.id
      left join public.official_collection_receipts r
        on r.payment_id = pm.id and r.status = 'active'
      cross join lateral (
        select * from public.get_effective_government_policy(pm.club_id, bk.branch_id, bk.field_id)
      ) pol
      where pm.club_id = p_club_id
        and pol.enabled
        and pol.official_receipt_required
        and pm.method = any(pol.required_payment_methods)
        and pm.received_at >= pol.effective_from
        and r.id is null
    ) as missing_receipt_payment_count,
    (
      select count(*)
      from public.official_collection_receipts
      where club_id = p_club_id and status = 'reversed'
    ) as reversed_awaiting_review_count;
end;
$function$;

revoke all on function public.get_government_compliance_exceptions(uuid) from public;
revoke all on function public.get_government_compliance_exceptions(uuid) from anon;
grant execute on function public.get_government_compliance_exceptions(uuid) to authenticated;
