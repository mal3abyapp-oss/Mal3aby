-- FINAL AUTONOMOUS REMEDIATION -- Security cleanup (from live
-- get_advisors(security) scan run as part of this remediation pass's
-- final gate): 2 function_search_path_mutable findings.
--
-- 1. public.temp_log_fn() -- already dropped in a prior migration
-- this session (20260818... drop_orphaned_debug_function): confirmed
-- orphaned debug artifact (not SECURITY DEFINER, references a
-- nonexistent `t_log` table, attached to no trigger). No action
-- needed here, noted for the record.
--
-- 2. public.get_invoice_payment_summary(uuid[]) -- SECURITY INVOKER
-- (not DEFINER, confirmed via pg_proc -- so this was never a
-- privilege-escalation risk, just a lower-severity hardening gap) SQL
-- function with no search_path pinned. Fixed by adding `set
-- search_path = public, pg_temp`, matching every other function in
-- this schema's own established convention.
create or replace function public.get_invoice_payment_summary(p_invoice_ids uuid[])
returns table(invoice_id uuid, total numeric, paid numeric, refunded numeric, outstanding numeric, payment_status text)
language sql
stable
set search_path = public, pg_temp
as $function$
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
       where pa.invoice_id = i.id) as refunded_amount
  ) alloc on true
  where i.id = any(p_invoice_ids);
$function$;
