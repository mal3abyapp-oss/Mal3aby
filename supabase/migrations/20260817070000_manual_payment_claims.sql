-- Master Payment Directive Phase 7-8 (task #83): customer payment
-- instructions + manual transfer claim + staff verification.
--
-- Follows the exact state-machine convention already established by
-- customer_photo_update_requests (Gate 3): a customer-initiated claim
-- never takes effect by itself -- it sits 'pending' until a staff
-- member with the right permission explicitly reviews it. Section 51:
-- "proof is not source of truth" -- a customer saying "I paid" (with
-- or without a reference/screenshot URL) NEVER marks anything paid by
-- itself. Only on staff approval does this call the REAL
-- record_payment() RPC, so the actual payment/invoice/booking state
-- stays derived from a genuine payments row through the single
-- financial source of truth built in task #81 -- never a parallel
-- "paid" flag invented here.
create table public.manual_payment_claims (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  invoice_id uuid not null references public.invoices(id),
  payment_method_config_id uuid references public.payment_method_configs(id),
  claimed_by uuid not null references auth.users(id),
  claimed_amount numeric not null check (claimed_amount > 0),
  reference text,
  proof_note text, -- free-text reference/screenshot-link the customer provides as evidence (Section 50) -- not itself proof of payment (Section 51)
  claimed_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  review_reason text,
  resulting_payment_id uuid references public.payments(id)
);

alter table public.manual_payment_claims enable row level security;

-- A customer may only claim against their OWN invoice.
create policy "manual_payment_claims_self_service_insert" on public.manual_payment_claims
  for insert with check (
    claimed_by = auth.uid()
    and invoice_id in (
      select i.id from public.invoices i
      join public.customers c on c.id = i.customer_id
      where c.user_id = auth.uid()
    )
  );

create policy "manual_payment_claims_self_service_select" on public.manual_payment_claims
  for select using (claimed_by = auth.uid());

create policy "manual_payment_claims_staff_select" on public.manual_payment_claims
  for select using (club_id in (select public.user_club_ids()) and public.has_permission('payment.verify', club_id));

comment on table public.manual_payment_claims is
  'Master Payment Directive task #83: a customer claims they transferred money for an invoice (InstaPay/wallet/bank). Stays pending -- and the invoice stays whatever its real payments say -- until staff verifies it via verify_manual_payment_claim(), which is the ONLY path that calls the real record_payment() RPC. Never a parallel paid flag.';

create or replace function public.claim_manual_payment(
  p_invoice_id uuid,
  p_payment_method_config_id uuid,
  p_claimed_amount numeric,
  p_reference text default null,
  p_proof_note text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim_id uuid;
  v_club_id uuid;
  v_customer_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select i.club_id, i.customer_id into v_club_id, v_customer_id
  from public.invoices i
  join public.customers c on c.id = i.customer_id
  where i.id = p_invoice_id and c.user_id = auth.uid();

  if v_club_id is null then
    raise exception 'invoice not found or does not belong to your account';
  end if;

  if p_claimed_amount <= 0 then
    raise exception 'claimed amount must be positive';
  end if;

  insert into public.manual_payment_claims (club_id, invoice_id, payment_method_config_id, claimed_by, claimed_amount, reference, proof_note)
  values (v_club_id, p_invoice_id, p_payment_method_config_id, auth.uid(), p_claimed_amount, p_reference, p_proof_note)
  returning id into v_claim_id;

  return v_claim_id;
end;
$$;

revoke execute on function public.claim_manual_payment(uuid, uuid, numeric, text, text) from public, anon;
grant execute on function public.claim_manual_payment(uuid, uuid, numeric, text, text) to authenticated;

create or replace function public.verify_manual_payment_claim(
  p_claim_id uuid,
  p_approve boolean,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claim record;
  v_underlying_method text;
  v_payment_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_claim from public.manual_payment_claims where id = p_claim_id for update;
  if v_claim.id is null then
    raise exception 'claim not found';
  end if;

  if not (v_claim.club_id in (select public.user_club_ids()) and public.has_permission('payment.verify', v_claim.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_claim.status != 'pending' then
    raise exception 'this claim has already been reviewed';
  end if;

  if p_approve then
    -- Resolve the actual payments.method this config maps onto (Section
    -- 28-29's cash/instapay/wallet/bank distinction is a config-layer
    -- concept; record_payment() only knows the underlying enum).
    select underlying_method into v_underlying_method
    from public.payment_method_configs where id = v_claim.payment_method_config_id;

    -- record_payment() is the ONLY place a real payments row (and
    -- therefore the single source of truth's paid/outstanding/status)
    -- gets created -- this claim table never fabricates payment state
    -- directly, so get_invoice_payment_summary() stays authoritative.
    v_payment_id := public.record_payment(
      v_claim.invoice_id,
      v_claim.claimed_amount,
      coalesce(v_underlying_method, 'other'),
      v_claim.reference
    );
  end if;

  update public.manual_payment_claims
  set status = case when p_approve then 'verified' else 'rejected' end,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      review_reason = p_reason,
      resulting_payment_id = v_payment_id
  where id = p_claim_id;

  perform public.write_audit_log(
    v_claim.club_id,
    case when p_approve then 'manual_payment_claim.verify' else 'manual_payment_claim.reject' end,
    'manual_payment_claim', p_claim_id,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('claimed_amount', v_claim.claimed_amount, 'payment_id', v_payment_id),
    p_reason
  );

  return v_payment_id;
end;
$$;

revoke execute on function public.verify_manual_payment_claim(uuid, boolean, text) from public, anon;
grant execute on function public.verify_manual_payment_claim(uuid, boolean, text) to authenticated;

-- ============================================================
-- Seed payment.verify permission (Section 98).
-- ============================================================
insert into public.permissions (key, description) values
  ('payment.verify', 'Verify or reject a customer''s manual payment claim')
on conflict (key) do nothing;

-- verify_manual_payment_claim() calls the real record_payment() RPC on
-- approval, which itself requires payment.create -- so payment.verify
-- must be granted to exactly the roles that already hold
-- payment.create (club_owner, receptionist, accountant), not a wider
-- set, or approval would pass the payment.verify gate here only to
-- fail inside record_payment() with 'not authorized'.
insert into public.role_permissions (role_id, permission_id)
select rp.role_id, p.id
from public.role_permissions rp
join public.permissions existing on existing.id = rp.permission_id and existing.key = 'payment.create'
cross join public.permissions p
where p.key = 'payment.verify'
on conflict do nothing;
