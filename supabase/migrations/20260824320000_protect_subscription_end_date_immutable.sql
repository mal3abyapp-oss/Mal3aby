-- SECURITY FIX (HIGH, live-verified via this audit's real academy-
-- fraud testing -- project gxkrtlvpjwxhcqdisyob): subscriptions.end_date
-- was not protected against direct client-side UPDATE. Any staff
-- member holding subscription.update (academy_manager/club_manager/
-- club_owner) could bypass every billing/audit RPC by issuing a raw
-- UPDATE through PostgREST/the Supabase client, extending a
-- subscription's paid validity indefinitely with NO invoice, NO
-- payment, and NO audit_logs entry -- invisible to the same audit
-- trail every other lifecycle operation (freeze/unfreeze/cancel/
-- renew) deliberately writes to.
--
-- Live-reproduced (rolled back, no persisted change) by this audit:
--   update public.subscriptions set end_date = end_date + interval '365 days'
--   where id = '<real subscription id>' -- succeeded, end_date changed,
--   zero audit_logs rows written for the same window.
--
-- ROOT CAUSE: protect_subscription_price_immutable() (this project's
-- existing column-immutability trigger, already freezing price/
-- discount/enrollment_id/plan_type/start_date against direct UPDATE)
-- simply omitted end_date from its guarded-column list.
--
-- FIX: freeze end_date the same way, with NO escape-hatch flag needed
-- (unlike status, which legitimately transitions via freeze/unfreeze/
-- cancel RPCs updating the SAME row) -- confirmed via
-- renew_academy_subscription()'s own body that it always INSERTs a
-- brand-new subscription row with the new end_date rather than
-- UPDATing an existing row's end_date, and freeze/unfreeze never touch
-- end_date at all (extension is computed on READ via
-- get_subscription_effective_end_date(), summing extends_expiry=true
-- freeze spans -- the stored end_date itself is never meant to change
-- after insert). So end_date can be made fully immutable post-insert,
-- with zero legitimate write path needing an override.

create or replace function public.protect_subscription_price_immutable()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if new.price is distinct from old.price then
    new.price := old.price;
  end if;
  if new.discount is distinct from old.discount then
    new.discount := old.discount;
  end if;
  if new.enrollment_id is distinct from old.enrollment_id then
    new.enrollment_id := old.enrollment_id;
  end if;
  if new.plan_type is distinct from old.plan_type then
    new.plan_type := old.plan_type;
  end if;
  if new.start_date is distinct from old.start_date then
    new.start_date := old.start_date;
  end if;
  if new.end_date is distinct from old.end_date then
    new.end_date := old.end_date;
  end if;
  return new;
end;
$$;

-- Signature unchanged (still a trigger function, no new arguments) --
-- in-place replace, no grant changes needed (trigger functions aren't
-- directly EXECUTE-callable regardless of grants).
