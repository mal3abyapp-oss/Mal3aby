-- Master Payment Directive task #86: secure invoice QR + verification
-- page.
--
-- Per docs/ARCHITECTURE.md's own "QR Strategy" section (written before
-- this task, at Phase 8): "Invoice QR, if used, is explicitly a
-- lookup/verification reference -- never an access credential, never a
-- qr_credentials row in the access-control sense, and scanning it
-- never consumes anything." This migration follows that documented
-- design exactly: a genuinely separate table from qr_credentials (not
-- reused, per the docs' explicit instruction), and a public/anon RPC
-- (unlike every qr_credentials RPC, which requires staff auth) --
-- because the entire point of a QR printed on a customer-facing
-- invoice/receipt is that the CUSTOMER (or any third party holding the
-- paper, e.g. an auditor) can scan it without a staff login, to
-- confirm the invoice is genuine and see its real payment status.
--
-- Security posture, deliberately conservative: the public verification
-- RPC returns ONLY invoice_number, issued_at, total, and a coarse
-- payment status -- never customer name/phone/email, never itemized
-- line items, never any internal ID beyond the invoice_number the
-- customer already has on their printed copy. This is a strictly
-- narrower payload than what a customer already holds on the paper
-- invoice itself, so scanning the QR cannot leak anything the paper
-- didn't already show them.

create table public.invoice_verification_tokens (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  invoice_id uuid not null references public.invoices(id),
  token_hash text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);

create index invoice_verification_tokens_invoice_idx on public.invoice_verification_tokens (invoice_id);

alter table public.invoice_verification_tokens enable row level security;

-- Staff (own club) can see that a token exists, same pattern as
-- qr_credentials -- token_hash itself is never selected by any
-- frontend query (features query specific columns), and this table's
-- own RPCs never return it either.
create policy "invoice_verification_tokens_select_own_club" on public.invoice_verification_tokens
  for select using (club_id in (select public.user_club_ids()));

-- No direct client INSERT/UPDATE policy -- written only by
-- ensure_invoice_qr() (SECURITY DEFINER), matching qr_credentials'
-- own "no direct client write" convention.
alter table public.invoice_verification_tokens force row level security;

comment on table public.invoice_verification_tokens is
  'Task #86: opaque, hashed-at-rest lookup tokens for the public invoice verification page. Deliberately NOT qr_credentials (per docs/ARCHITECTURE.md''s QR Strategy section) -- this is a read-only lookup reference, never an access credential, and verifying one never consumes or mutates anything.';

-- ============================================================
-- ensure_invoice_qr: staff-only, idempotent-per-call (revokes any
-- prior active token for this invoice before issuing a new one, same
-- "at most one active credential" pattern as ensure_booking_qr).
-- Returns the raw token -- only time it is ever exposed; only
-- sha256(token) is persisted.
-- ============================================================
create or replace function public.ensure_invoice_qr(p_invoice_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_status text;
  v_raw_token text;
  v_token_hash text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select club_id, status into v_club_id, v_status from public.invoices where id = p_invoice_id;
  if v_club_id is null then
    raise exception 'invoice not found';
  end if;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('invoice.view', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if v_status = 'draft' then
    raise exception 'cannot generate a verification QR for a draft invoice';
  end if;

  update public.invoice_verification_tokens
  set status = 'revoked'
  where invoice_id = p_invoice_id and status = 'active';

  v_raw_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_token_hash := encode(extensions.digest(v_raw_token, 'sha256'), 'hex');

  insert into public.invoice_verification_tokens (club_id, invoice_id, token_hash, status, created_by)
  values (v_club_id, p_invoice_id, v_token_hash, 'active', auth.uid());

  return v_raw_token;
end;
$$;

revoke execute on function public.ensure_invoice_qr(uuid) from public, anon;
grant execute on function public.ensure_invoice_qr(uuid) to authenticated;

comment on function public.ensure_invoice_qr(uuid) is
  'Task #86: staff-only (invoice.view permission), idempotent -- revokes any prior active token for this invoice before issuing a new one. Returns the raw token once; only its SHA-256 hash is stored.';

-- ============================================================
-- verify_invoice_public: PUBLIC (anon-callable), read-only, never
-- mutates anything. Returns only the minimal fields a customer's own
-- printed invoice already shows them -- deliberately excludes
-- customer name/phone/email/branch/items/internal IDs. A void invoice
-- verifies as void (never silently "not found") so a customer/auditor
-- can distinguish a genuinely voided invoice from a forged/garbage
-- token.
-- ============================================================
create or replace function public.verify_invoice_public(p_token text)
returns table(
  result text,
  invoice_number text,
  issued_at timestamptz,
  total numeric,
  payment_status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token_hash text;
  v_vt record;
  v_inv record;
  v_summary record;
begin
  v_token_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_vt from public.invoice_verification_tokens where token_hash = v_token_hash;

  if v_vt.id is null or v_vt.status <> 'active' then
    return query select 'invalid'::text, null::text, null::timestamptz, null::numeric, null::text;
    return;
  end if;

  select * into v_inv from public.invoices where id = v_vt.invoice_id;
  if v_inv.id is null then
    return query select 'invalid'::text, null::text, null::timestamptz, null::numeric, null::text;
    return;
  end if;

  select * into v_summary from public.get_invoice_payment_summary(array[v_inv.id]::uuid[]);

  return query
    select 'success'::text, v_inv.invoice_number, v_inv.issued_at, v_inv.total,
           coalesce(v_summary.payment_status, 'unpaid');
end;
$$;

-- Deliberately granted to BOTH anon and authenticated -- this is the
-- one QR-adjacent RPC in this schema meant to be reachable without any
-- login at all, matching the documented "customer/any holder of the
-- paper invoice can verify it" design intent. Never touches
-- qr_scan_events or any staff-facing audit surface -- this is a public
-- lookup, not a staff scan action.
revoke execute on function public.verify_invoice_public(text) from public;
grant execute on function public.verify_invoice_public(text) to anon, authenticated;

comment on function public.verify_invoice_public(text) is
  'Task #86: PUBLIC, anon-callable, read-only invoice verification lookup. Returns only invoice_number/issued_at/total/payment_status -- never customer PII, never line items, never any internal ID. A void invoice verifies honestly as its own payment_status (never silently "not found"), so a genuinely voided invoice is distinguishable from a forged/garbage token. Never mutates any row.';
