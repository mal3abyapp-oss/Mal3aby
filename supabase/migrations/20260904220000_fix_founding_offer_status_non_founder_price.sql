-- FIX: get_founding_offer_status() non-founder current_effective_price
-- was always null (2026-09-04 commercial packaging mission).
--
-- Found via real runtime RPC testing (not code review alone): a
-- non-founder club with a real active paid subscription (e.g. a 50,000
-- EGP Pro Annual plan) called get_founding_offer_status() and got
-- current_effective_price=null instead of its real current price. Root
-- cause: the non-founder branch (v_slot.slot_number is null) returned
-- an unconditional null row for every price-shaped column -- it never
-- looked at the club's actual platform_subscriptions row at all, only
-- founding_customer_slots (which correctly has nothing for a
-- non-founder).
--
-- Fix: for a non-founder club, resolve current_effective_price from
-- that club's most recent ACTIVE, PAID platform_subscriptions row's
-- price_snapshot -- the same column every other part of this schema
-- already treats as the single source of truth for "what this club is
-- actually being charged" (see create_platform_subscription,
-- MAL3ABY_V1_PRICING_MIGRATION.md's snapshot-immutability guarantee).
-- A club with no active paid subscription (e.g. still on trial, or
-- expired/cancelled) correctly still gets null -- there is no "current
-- price" to show in that case, which is honest, not a bug.
create or replace function public.get_founding_offer_status(p_club_id uuid)
returns table(
  is_founder boolean,
  slot_number integer,
  list_price numeric,
  promotional_price numeric,
  promotion_start timestamptz,
  promotion_end timestamptz,
  normal_price_after_promotion numeric,
  current_effective_price numeric,
  promotion_active boolean,
  slots_remaining integer
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_slot record;
  v_taken integer;
  v_current_paid_price numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;
  if not (p_club_id in (select public.user_club_ids())) and not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  select count(*) into v_taken from public.founding_customer_slots;

  select * into v_slot from public.founding_customer_slots where club_id = p_club_id;
  if v_slot.slot_number is null then
    -- Non-founder: resolve current_effective_price from the club's own
    -- most recent active paid subscription, if any.
    select ps.price_snapshot into v_current_paid_price
    from public.platform_subscriptions ps
    where ps.club_id = p_club_id and ps.subscription_kind = 'paid' and ps.lifecycle_status = 'active'
    order by ps.created_at desc
    limit 1;

    return query select false, null::integer, null::numeric, null::numeric, null::timestamptz,
      null::timestamptz, null::numeric, v_current_paid_price, false, greatest(0, 5 - v_taken);
    return;
  end if;

  return query select
    true, v_slot.slot_number, v_slot.list_price, v_slot.promotional_price,
    v_slot.promotion_start, v_slot.promotion_end, v_slot.normal_price_after_promotion,
    case when now() < v_slot.promotion_end then v_slot.promotional_price else v_slot.normal_price_after_promotion end,
    now() < v_slot.promotion_end,
    greatest(0, 5 - v_taken);
end;
$$;

revoke all on function public.get_founding_offer_status(uuid) from public, anon;
grant execute on function public.get_founding_offer_status(uuid) to authenticated;

comment on function public.get_founding_offer_status(uuid) is
  'Read-only. current_effective_price/promotion_active are computed from now() vs promotion_end for a founder -- no cron/scheduled job needed to "revert" pricing after 3 months, it is always a pure function of stored dates. For a NON-founder club, current_effective_price resolves to that club''s own most recent active paid subscription price_snapshot (null if no active paid subscription exists, e.g. still on trial). Fixed 2026-09-04: previously always null for non-founders, found via real runtime RPC testing.';
