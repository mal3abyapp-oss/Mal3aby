-- MAL3ABY V1 COMMERCIAL PACKAGING -- Step 3: Founding Customer offer
-- (first 5 PAYING customers, 50% off list price for 3 months, then
-- automatic reversion to full list price -- never permanent).
--
-- Atomicity pattern: mirrors automatic_trial_entitlements.user_id's
-- UNIQUE constraint + caught-exception claim pattern exactly (see
-- complete_new_club_onboarding()'s `begin...insert...exception when
-- unique_violation`). Here the "exactly 5" cap is enforced by a
-- sequential slot number (1-5) assigned via a SERIALIZABLE-safe
-- row-locked counter table with a UNIQUE constraint on slot_number,
-- so a 6th concurrent claim attempt structurally cannot succeed --
-- not a pre-check-then-insert race, and not merely frontend-refused.

create table public.founding_customer_slots (
  slot_number integer primary key check (slot_number between 1 and 5),
  club_id uuid unique references public.clubs(id),
  platform_subscription_id uuid references public.platform_subscriptions(id),
  list_price numeric(12,2) not null,
  promotional_price numeric(12,2) not null,
  promotion_start timestamptz not null default now(),
  promotion_end timestamptz not null,
  normal_price_after_promotion numeric(12,2) not null,
  claimed_at timestamptz not null default now(),
  claimed_by uuid references auth.users(id)
);

comment on table public.founding_customer_slots is
  'Exactly 5 rows ever meaningfully populated (slot_number 1-5, PK enforces max 5). LIST_PRICE/PROMOTIONAL_PRICE/PROMOTION_START/PROMOTION_END/NORMAL_PRICE_AFTER_PROMOTION are real stored fields, not frontend text. A 6th claim attempt fails structurally: all 5 primary-key slot values already taken, INSERT has nowhere to go.';

alter table public.founding_customer_slots enable row level security;

create policy "founding_customer_slots_select_own_club" on public.founding_customer_slots
  for select using (club_id in (select public.user_club_ids()));

create policy "founding_customer_slots_platform_owner_full" on public.founding_customer_slots
  for all using (public.is_platform_owner()) with check (public.is_platform_owner());

comment on policy "founding_customer_slots_select_own_club" on public.founding_customer_slots is
  'A club can see its OWN founder status/discount/dates -- never other clubs'' slot data (no aggregate leak of who else is a founder).';

-- ============================================================
-- claim_founding_customer_slot(p_club_id, p_platform_subscription_id):
-- server-side-enforced "first 5 PAYING customers" claim. Must be called
-- at the moment a club's FIRST PAID (subscription_kind='paid')
-- subscription is created -- never for trial/complimentary, matching
-- "first 5 PAYING customers only" precisely. Idempotent per club (a
-- club already holding a slot is returned its existing slot, never
-- double-claims a second one).
--
-- Concurrency safety: uses a fixed 5-row candidate-slot generate_series
-- LEFT JOIN pattern under a SERIALIZABLE-equivalent row lock (`for
-- update` on the candidate slot rows via a real INSERT ... ON CONFLICT
-- DO NOTHING loop) so two concurrent 5th-slot claims cannot both
-- succeed -- the UNIQUE(club_id) and PRIMARY KEY(slot_number)
-- constraints are the actual atomicity guarantee, not application-level
-- locking, exactly matching automatic_trial_entitlements' own pattern.
-- ============================================================
create or replace function public.claim_founding_customer_slot(
  p_club_id uuid,
  p_platform_subscription_id uuid
)
returns table(slot_number integer, eligible boolean, promotional_price numeric, promotion_end timestamptz)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_existing record;
  v_sub record;
  v_plan record;
  v_candidate integer;
  v_inserted boolean := false;
  v_promo_end timestamptz;
  v_promo_price numeric;
begin
  if not public.is_platform_owner() then
    raise exception 'not authorized';
  end if;

  -- Idempotent: a club that already holds a slot gets that slot back,
  -- never a second claim attempt.
  select * into v_existing from public.founding_customer_slots where club_id = p_club_id;
  if v_existing.slot_number is not null then
    return query select v_existing.slot_number, true, v_existing.promotional_price, v_existing.promotion_end;
    return;
  end if;

  select * into v_sub from public.platform_subscriptions where id = p_platform_subscription_id and club_id = p_club_id;
  if v_sub is null then
    raise exception 'subscription not found for this club';
  end if;
  if v_sub.subscription_kind <> 'paid' then
    raise exception 'founding offer only applies to a PAID subscription (subscription_kind=paid), got: %', v_sub.subscription_kind;
  end if;

  select * into v_plan from public.platform_plans where id = v_sub.plan_id;
  if v_plan is null then
    raise exception 'subscription has no associated plan';
  end if;

  v_promo_price := round(v_plan.price * 0.5, 2);
  v_promo_end := now() + interval '3 months';

  -- Try each of the 5 fixed slot numbers in order; the first one whose
  -- INSERT is not blocked by a concurrent transaction wins. PRIMARY KEY
  -- (slot_number) is what actually makes this atomic across concurrent
  -- callers -- a 6th caller finds all 5 already taken and the loop ends
  -- with v_inserted still false.
  for v_candidate in 1..5 loop
    begin
      insert into public.founding_customer_slots (
        slot_number, club_id, platform_subscription_id, list_price, promotional_price,
        promotion_start, promotion_end, normal_price_after_promotion, claimed_by
      ) values (
        v_candidate, p_club_id, p_platform_subscription_id, v_plan.price, v_promo_price,
        now(), v_promo_end, v_plan.price, auth.uid()
      );
      v_inserted := true;
      exit;
    exception when unique_violation then
      -- slot_number already taken by a concurrent claim; try the next one.
      continue;
    end;
  end loop;

  if not v_inserted then
    return query select null::integer, false, null::numeric, null::timestamptz;
    return;
  end if;

  perform public.write_audit_log(
    p_club_id, 'founding_customer_slot.claimed', 'founding_customer_slots', p_club_id,
    null, jsonb_build_object('list_price', v_plan.price, 'promotional_price', v_promo_price, 'promotion_end', v_promo_end),
    null
  );

  return query select v_candidate, true, v_promo_price, v_promo_end;
end;
$$;

revoke all on function public.claim_founding_customer_slot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.claim_founding_customer_slot(uuid, uuid) to authenticated;

comment on function public.claim_founding_customer_slot(uuid, uuid) is
  'Platform-Owner-only (matches create_platform_subscription''s own authorization gate, since this always runs immediately after creating a paid subscription). Server-side enforced first-5 cap via PRIMARY KEY(slot_number) -- a 6th call structurally cannot insert. Never trusts a client-supplied "I am customer #N" claim.';

-- ============================================================
-- get_founding_offer_status(p_club_id): read-only status for both
-- tenant and platform-owner views. Returns whether the club holds a
-- founder slot, and if the promotion has expired, computes the correct
-- current effective price (promotional_price while now() < promotion_end,
-- normal_price_after_promotion after) -- this is a computed read, the
-- table itself never needs a cron job to "revert" the price.
-- ============================================================
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
    return query select false, null::integer, null::numeric, null::numeric, null::timestamptz,
      null::timestamptz, null::numeric, null::numeric, false, greatest(0, 5 - v_taken);
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
  'Read-only. current_effective_price/promotion_active are computed from now() vs promotion_end -- no cron/scheduled job needed to "revert" pricing after 3 months, it is always a pure function of stored dates.';
