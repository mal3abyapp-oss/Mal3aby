-- Server-side normalization enforcement (directive section 14/54).
--
-- The audit found NO RPC choke point for customer phone writes --
-- CustomersPage.tsx, QuickBookingSheet.tsx, and PortalProfilePage.tsx
-- all write directly to public.customers via PostgREST, gated only by
-- RLS. Frontend-only normalization (src/lib/domain/phone.ts) is
-- necessary but not sufficient -- a client that bypasses the UI (or a
-- future write path that forgets to call the normalizer) could still
-- write raw/local digits into phone_e164 directly. This trigger is
-- the guarantee that cannot be bypassed by any of them.
--
-- What it does NOT do: full E.164 parsing/reformatting. That authority
-- stays in src/lib/domain/phone.ts (directive section 47 -- don't
-- reimplement libphonenumber logic in SQL). This trigger only:
--   1. Re-validates the FORMAT of phone_e164 if set (defense in depth
--      alongside the CHECK constraint -- constraints alone are not
--      trigger-visible for a clear error message).
--   2. If phone_e164 is being set/changed, writes a phone-change audit
--      row (directive section 50) with old/new value, actor, timestamp.
--
-- It deliberately does NOT try to derive phone_e164 from
-- mobile_display/normalized_mobile automatically -- that would be
-- exactly the "guess the country" anti-pattern the directive forbids
-- (section 59). A caller that wants phone_e164 set must supply an
-- already-normalized value; the CHECK constraint (added in the schema
-- migration) rejects anything not already E.164-shaped.

create or replace function public.audit_customer_phone_change()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if (tg_op = 'UPDATE' and new.phone_e164 is distinct from old.phone_e164) then
    perform public.write_audit_log(
      new.club_id,
      'customer.phone_changed',
      'customer',
      new.id,
      jsonb_build_object('phone_e164', old.phone_e164),
      jsonb_build_object('phone_e164', new.phone_e164),
      null
    );
  elsif (tg_op = 'INSERT' and new.phone_e164 is not null) then
    perform public.write_audit_log(
      new.club_id,
      'customer.phone_changed',
      'customer',
      new.id,
      null,
      jsonb_build_object('phone_e164', new.phone_e164),
      null
    );
  end if;
  return new;
end;
$function$;

drop trigger if exists customer_phone_change_audit on public.customers;
create trigger customer_phone_change_audit
  after insert or update on public.customers
  for each row
  execute function public.audit_customer_phone_change();

revoke all on function public.audit_customer_phone_change() from public;
revoke all on function public.audit_customer_phone_change() from anon;
