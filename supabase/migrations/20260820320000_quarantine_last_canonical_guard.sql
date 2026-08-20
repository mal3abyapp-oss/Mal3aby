-- Gap found in closure review: quarantine_duplicate_customer had no
-- check preventing an operator from quarantining the LAST canonical
-- holder of a phone number. If a phone currently has exactly one
-- canonical customer (no sibling duplicate), quarantining it leaves
-- ZERO canonical rows for that phone -- the unique index's WHERE
-- duplicate_review_status = 'none' slot reopens, and a genuinely new
-- person could be inserted under the same phone with no relationship
-- to the quarantined history at all. The invariant this schema must
-- hold: for every (club_id, phone_e164) that has EVER had a canonical
-- customer, there must always be at least one canonical holder
-- while any customer record for that phone still exists.
--
-- Fix: quarantine_duplicate_customer now requires a DIFFERENT
-- customer with the same phone_e164 to already be canonical before
-- it will quarantine this one. This also correctly implies
-- quarantining requires an existing duplicate group (you cannot
-- quarantine a phone's only customer, full stop).
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
declare
  v_phone text;
  v_other_canonical_id uuid;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select phone_e164 into v_phone from public.customers where id = p_customer_id and club_id = p_club_id;
  if not found then
    raise exception 'customer not found';
  end if;

  -- A customer with no phone at all has nothing to be a "duplicate"
  -- of in this scheme -- refuse rather than silently no-op.
  if v_phone is null then
    raise exception 'customer has no phone number -- nothing to quarantine as a duplicate of';
  end if;

  -- The invariant: never let this be the last canonical holder of
  -- v_phone. Requires a DIFFERENT customer already canonical for the
  -- same phone before this one may be quarantined.
  select id into v_other_canonical_id
  from public.customers
  where club_id = p_club_id
    and phone_e164 = v_phone
    and duplicate_review_status = 'none'
    and id != p_customer_id
  limit 1;

  if v_other_canonical_id is null then
    raise exception 'cannot quarantine the only canonical customer for this phone number -- quarantine an existing canonical record first, or this is not actually a duplicate';
  end if;

  update public.customers
  set duplicate_review_status = 'quarantined_pending_review'
  where id = p_customer_id and club_id = p_club_id;

  perform public.write_audit_log(
    p_club_id, 'customer.quarantined_as_duplicate', 'customer', p_customer_id,
    jsonb_build_object('duplicate_review_status', 'none'),
    jsonb_build_object('duplicate_review_status', 'quarantined_pending_review', 'reason', p_reason, 'canonical_sibling', v_other_canonical_id),
    null
  );
end;
$function$;

revoke execute on function public.quarantine_duplicate_customer(uuid, uuid, text) from public;
revoke execute on function public.quarantine_duplicate_customer(uuid, uuid, text) from anon;
grant execute on function public.quarantine_duplicate_customer(uuid, uuid, text) to authenticated;
