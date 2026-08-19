-- MAL3ABY PRODUCT/UX/BOOKING/PAYMENT DIRECTIVE -- Part 5: payment
-- receipt upload + club review workflow.
--
-- Private storage bucket ("payment-proofs") for uploaded receipt
-- images/PDFs -- never public, RLS-gated on the storage.objects table
-- itself, matching this codebase's own established pattern for
-- anything sensitive (session credentials, etc: private + RLS, never
-- "public bucket + obscure filename").
--
-- payment_proofs table: one row per uploaded receipt, always tied to a
-- real booking_id/invoice_id/club_id/customer_id (customer_id nullable
-- for a guest booking with no linked account, matching customers.
-- user_id's own existing nullability). Lifecycle: pending_review ->
-- approved | rejected. Approval goes through a real RPC
-- (approve_payment_proof) that calls the EXISTING record_payment() RPC
-- rather than writing payment/invoice state directly from the proof
-- review screen -- one consistent path for "a payment was received",
-- not two. Idempotent: approving an already-approved/rejected proof is
-- a no-op (checked by the RPC, not by ad-hoc frontend disabling), and
-- record_payment() itself already has real idempotency-key support the
-- RPC reuses.
create table public.payment_proofs (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  booking_id uuid references public.bookings(id),
  invoice_id uuid not null references public.invoices(id),
  customer_id uuid references public.customers(id),
  payment_method_config_id uuid references public.payment_method_configs(id),
  amount numeric not null check (amount > 0),
  storage_path text not null,
  mime_type text not null,
  file_size_bytes int not null,
  status text not null default 'pending_review' check (status in ('pending_review', 'approved', 'rejected')),
  rejection_reason text,
  uploaded_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  resulting_payment_id uuid references public.payments(id),
  created_by_customer boolean not null default true
);

comment on table public.payment_proofs is 'Customer-uploaded payment receipt images/PDFs awaiting club review. Approval creates a real payment via record_payment() (never writes payment/invoice state directly) -- one consistent money-movement path.';

create index payment_proofs_club_status_idx on public.payment_proofs (club_id, status);
create index payment_proofs_invoice_idx on public.payment_proofs (invoice_id);

alter table public.payment_proofs enable row level security;
alter table public.payment_proofs force row level security;

-- Staff: full read/write within their own club, gated by the same
-- permission key payment recording already uses (no new permission
-- key invented for this).
create policy payment_proofs_staff_all on public.payment_proofs
  for all to authenticated
  using (club_id in (select public.user_club_ids()) and public.has_permission('payment.create', club_id))
  with check (club_id in (select public.user_club_ids()) and public.has_permission('payment.create', club_id));

-- Customer (self-service, linked account): can read only their own
-- proofs, mirrors the existing bookings_self_service_select pattern.
create policy payment_proofs_customer_own on public.payment_proofs
  for select to authenticated
  using (customer_id in (select c.id from public.customers c where c.user_id = (select auth.uid())));

-- Storage bucket: private (never public), one bucket for all clubs'
-- receipts -- RLS on storage.objects enforces tenant isolation via the
-- path convention club_id/booking_id/filename (checked below), so a
-- single bucket doesn't leak across tenants any more than a per-club
-- bucket would, and avoids needing to provision a new bucket per club.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('payment-proofs', 'payment-proofs', false, 10485760, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do nothing;

-- Anyone (including anon, for a guest public-booking customer with no
-- account) can INSERT an object under payment-proofs/, but only via
-- the record_payment_proof_upload() RPC below actually recording it in
-- payment_proofs -- direct storage.objects INSERT alone creates an
-- orphaned file with no linked review-queue row, which is harmless
-- (never surfaced anywhere) but also never treated as a submitted
-- proof. Real access control is on payment_proofs (the row), not the
-- raw storage object, matching this bucket's "private, RLS-gated"
-- design intent from the directive.
create policy payment_proofs_bucket_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'payment-proofs');

-- SELECT (actually reading the file bytes back, e.g. for the club's
-- review screen or a customer re-viewing their own upload) is
-- restricted to staff-of-that-club or the uploading customer, checked
-- against the real payment_proofs row for that storage_path -- this is
-- the actual security boundary (directive: "Club A لا يستطيع قراءة
-- Proof لـ Club B", "Customer A لا يستطيع قراءة Proof لـ Customer B").
create policy payment_proofs_bucket_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'payment-proofs'
    and exists (
      select 1 from public.payment_proofs pp
      where pp.storage_path = storage.objects.name
        and (
          (pp.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', pp.club_id))
          or pp.customer_id in (select c.id from public.customers c where c.user_id = (select auth.uid()))
        )
    )
  );

-- RPC: records an uploaded file as a real payment_proofs row. The
-- actual file bytes are uploaded directly to Storage by the client
-- (Supabase JS storage.upload(), anon-safe per the bucket policy
-- above) BEFORE calling this -- this RPC only records the metadata +
-- enforces that storage_path actually starts with this exact
-- club_id/booking_id prefix (defense-in-depth: even if a caller
-- fabricated a path, it can't be recorded against a club/booking it
-- doesn't match).
create or replace function public.record_payment_proof_upload(
  p_booking_id uuid,
  p_amount numeric,
  p_storage_path text,
  p_mime_type text,
  p_file_size_bytes int,
  p_payment_method_config_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_booking record;
  v_proof_id uuid;
  v_expected_prefix text;
begin
  select id, club_id, invoice_id, customer_id, status into v_booking
  from public.bookings where id = p_booking_id;

  if v_booking.id is null then
    raise exception 'booking not found';
  end if;
  if v_booking.invoice_id is null then
    raise exception 'this booking has no invoice yet';
  end if;
  if p_amount <= 0 then
    raise exception 'amount must be positive';
  end if;
  if p_mime_type not in ('image/jpeg', 'image/png', 'application/pdf') then
    raise exception 'unsupported file type';
  end if;
  if p_file_size_bytes > 10485760 then
    raise exception 'file exceeds the 10MB size limit';
  end if;

  v_expected_prefix := v_booking.club_id::text || '/' || p_booking_id::text || '/';
  if left(p_storage_path, length(v_expected_prefix)) != v_expected_prefix then
    raise exception 'storage path does not match this booking';
  end if;

  insert into public.payment_proofs (club_id, booking_id, invoice_id, customer_id, payment_method_config_id, amount, storage_path, mime_type, file_size_bytes)
  values (v_booking.club_id, p_booking_id, v_booking.invoice_id, v_booking.customer_id, p_payment_method_config_id, p_amount, p_storage_path, p_mime_type, p_file_size_bytes)
  returning id into v_proof_id;

  perform public.write_audit_log(v_booking.club_id, 'payment_proof.upload', 'payment_proof', v_proof_id, null,
    jsonb_build_object('booking_id', p_booking_id, 'amount', p_amount), null);

  -- Notify the club a receipt is waiting for review -- reuses the
  -- existing notification-event mechanism (internal only here, not a
  -- customer-facing WhatsApp send, since this event has no customer
  -- template registered -- staff see it in their own Pending Payments
  -- queue instead, matching the directive's "Club Owner: Payment
  -- Proofs / Pending Payments" screen).
  perform public.emit_notification_event(v_booking.club_id, 'payment_proof.uploaded', 'payment_proof', v_proof_id,
    jsonb_build_object('booking_id', p_booking_id, 'amount', p_amount));

  return v_proof_id;
end;
$$;

revoke all on function public.record_payment_proof_upload(uuid, numeric, text, text, int, uuid) from public;
grant execute on function public.record_payment_proof_upload(uuid, numeric, text, text, int, uuid) to anon, authenticated;

-- RPC: club approves a pending proof -> calls the REAL record_payment()
-- RPC (single consistent money-movement path, directive Section 52:
-- "Approval يجب أن يمر عبر Business Logic/RPC الصحيحة... عملية واحدة
-- متسقة"). Idempotent: a proof already approved/rejected is a no-op
-- (returns its existing resulting_payment_id rather than erroring or
-- double-paying -- directive Section 53's "Approve مرتين لا ينشئ
-- دفعتين").
create or replace function public.approve_payment_proof(p_proof_id uuid, p_payment_method text default 'bank_transfer')
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_proof record;
  v_payment_id uuid;
begin
  select * into v_proof from public.payment_proofs where id = p_proof_id;
  if v_proof.id is null then
    raise exception 'payment proof not found';
  end if;

  if not (v_proof.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_proof.club_id)) then
    raise exception 'not authorized';
  end if;

  -- Idempotent: already-decided proof returns its prior result rather
  -- than re-processing.
  if v_proof.status = 'approved' then
    return v_proof.resulting_payment_id;
  end if;
  if v_proof.status = 'rejected' then
    raise exception 'this proof was already rejected -- ask the customer to submit a new one if needed';
  end if;

  -- record_payment() itself enforces the outstanding-balance cap, so a
  -- proof amount that no longer fits the invoice (e.g. another payment
  -- landed first) is correctly rejected by that RPC's own check rather
  -- than duplicated here.
  v_payment_id := public.record_payment(v_proof.invoice_id, v_proof.amount, p_payment_method, 'proof:' || p_proof_id::text, p_proof_id);

  update public.payment_proofs
  set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(), resulting_payment_id = v_payment_id
  where id = p_proof_id;

  perform public.write_audit_log(v_proof.club_id, 'payment_proof.approve', 'payment_proof', p_proof_id, null,
    jsonb_build_object('payment_id', v_payment_id, 'amount', v_proof.amount), null);

  return v_payment_id;
end;
$$;

revoke all on function public.approve_payment_proof(uuid, text) from public;
grant execute on function public.approve_payment_proof(uuid, text) to authenticated;

create or replace function public.reject_payment_proof(p_proof_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_proof record;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a rejection reason is required';
  end if;

  select * into v_proof from public.payment_proofs where id = p_proof_id;
  if v_proof.id is null then
    raise exception 'payment proof not found';
  end if;

  if not (v_proof.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_proof.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_proof.status != 'pending_review' then
    raise exception 'only a pending proof can be rejected';
  end if;

  update public.payment_proofs
  set status = 'rejected', rejection_reason = p_reason, reviewed_at = now(), reviewed_by = auth.uid()
  where id = p_proof_id;

  perform public.write_audit_log(v_proof.club_id, 'payment_proof.reject', 'payment_proof', p_proof_id, null,
    jsonb_build_object('reason', p_reason), null);
end;
$$;

revoke all on function public.reject_payment_proof(uuid, text) from public;
grant execute on function public.reject_payment_proof(uuid, text) to authenticated;

-- Anon/guest-safe status read: lets the public booking confirmation /
-- Secure Booking page show "proof under review" without requiring an
-- authenticated session, scoped to one specific booking (same pattern
-- as get_public_payment_methods_for_booking).
create or replace function public.get_public_payment_proof_status(p_booking_id uuid)
returns table(status text, uploaded_at timestamptz, rejection_reason text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  select status, uploaded_at, rejection_reason
  from public.payment_proofs
  where booking_id = p_booking_id
  order by uploaded_at desc
  limit 1;
$$;

revoke all on function public.get_public_payment_proof_status(uuid) from public;
grant execute on function public.get_public_payment_proof_status(uuid) to anon, authenticated;
