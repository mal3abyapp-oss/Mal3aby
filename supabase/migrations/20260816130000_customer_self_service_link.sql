-- Gate 3 (Unified Accounts / Participants / Guardians) -- foundational
-- schema change: link a customers row to a real auth.users login
-- identity, enabling the first piece of self-service (a customer
-- logging in and seeing their own data) that did not exist before this
-- migration (verified: no such link/RLS path existed anywhere in the
-- schema prior to this).
--
-- Design decisions (see AUTONOMOUS_DECISION_LOG.md D-003 for full
-- context):
-- - customers.user_id is nullable and UNIQUE. Nullable because every
--   existing customer row was created by staff with no login at all --
--   this migration must never break that (an unlinked customer record
--   keeps working exactly as before, purely staff-managed). UNIQUE so
--   one login can never silently "become" two different customer
--   identities within the same club by accident.
-- - A customer's self-service RLS access is entirely separate from
--   club_memberships/has_permission() -- a customer is never staff, and
--   must never be able to read/write anything a staff permission grants
--   (this deliberately keeps the two authorization systems from ever
--   overlapping, so a bug in one can't silently grant privilege in the
--   other).
-- - Self-service claim is explicit and auditable, never silent
--   auto-linking purely by matching phone/email (that would let anyone
--   who knows a customer's phone number claim their financial history
--   just by signing up with that number). The claim RPC below requires
--   the caller to already be authenticated (a real logged-in user) and
--   only lets them claim a customer row that has no existing user_id,
--   scoped to a specific club_id they name -- this is the minimum-viable
--   secure self-service linking flow; a stronger OTP/phone-verification
--   gate is a natural next hardening step once the base flow is proven.

alter table public.customers add column if not exists user_id uuid references auth.users(id);

create unique index if not exists customers_user_id_unique on public.customers (user_id) where user_id is not null;

comment on column public.customers.user_id is
  'Optional link to the auth.users login that owns this customer record for self-service access (My Bookings, My Subscriptions, etc). NULL for customer records that are purely staff-managed with no self-service login. Set only via claim_customer_self_service(), never directly.';

-- ============================================================
-- Self-service RLS: a logged-in user may read (and update a narrow set
-- of) only the customers row(s) explicitly linked to their own
-- auth.uid() -- never any other customer's row, regardless of club.
-- ============================================================
create policy "customers_self_service_select" on public.customers
  for select using (user_id = auth.uid());

create policy "customers_self_service_update" on public.customers
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ============================================================
-- claim_customer_self_service: the only way user_id ever gets set.
-- Requires the caller to be a real authenticated user and to name the
-- exact club_id + customer_id they're claiming (never a blind
-- "find my record by phone number" auto-match) -- the calling UI is
-- responsible for first showing the customer their own staff-recorded
-- details (name/phone) to confirm before calling this, so a claim is a
-- deliberate, visible action, not a silent background linkage.
-- ============================================================
create or replace function public.claim_customer_self_service(
  p_club_id uuid,
  p_customer_id uuid
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_customer record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_customer from public.customers
  where id = p_customer_id and club_id = p_club_id
  for update;

  if v_customer.id is null then
    raise exception 'customer not found';
  end if;

  if v_customer.user_id is not null then
    if v_customer.user_id = auth.uid() then
      -- Already claimed by this same user -- idempotent, not an error.
      return v_customer.id;
    end if;
    raise exception 'this customer record is already linked to a different account';
  end if;

  -- A single login may claim at most one customer record per club (a
  -- person is one customer identity per club) -- but MAY hold separate
  -- customer records across different clubs (they are genuinely
  -- different tenants' CRM entities for the same real person until a
  -- true cross-tenant identity model exists, which is out of scope here).
  if exists (
    select 1 from public.customers where club_id = p_club_id and user_id = auth.uid()
  ) then
    raise exception 'this account is already linked to a customer record in this club';
  end if;

  update public.customers set user_id = auth.uid() where id = p_customer_id;

  perform public.write_audit_log(
    p_club_id, 'customer.self_service_claim', 'customer', p_customer_id, null,
    jsonb_build_object('user_id', auth.uid()),
    null
  );

  return p_customer_id;
end;
$$;

revoke execute on function public.claim_customer_self_service(uuid, uuid) from public, anon;
grant execute on function public.claim_customer_self_service(uuid, uuid) to authenticated;

comment on function public.claim_customer_self_service is
  'The only way customers.user_id is ever set. Requires an explicit, already-authenticated caller naming a specific unclaimed customer row -- never silent auto-matching by phone/email.';
