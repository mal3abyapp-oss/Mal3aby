# Commerce Pro — Phase C4 Report: Invoices, Thermal Receipts, Payment Receipts, Club Branding

Written 2026-08-28, in isolated worktree `worktree-agent-a7ab9225d43599675`
(built on top of C1–C3, already merged in this worktree), per
`COMMERCE_PRO_UPGRADE_PLAN.md` Section 5 (Phase C4) and
`AGENT_ORCHESTRATION_GOVERNANCE.md`. Scope: Invoices, Thermal Receipts,
Payment Receipts, Club Branding settings only.

## 1. Club branding — `tax_info`/`invoice_settings` shape chosen

Confirmed live via direct schema read
(`20260815120000_phase2_identity_multitenant_rls.sql`): `clubs.logo_url
text`, `clubs.tax_info jsonb`, `clubs.invoice_settings jsonb` already
exist, confirmed unused anywhere in the app (only `logo_url` had real
readers — `MembershipCard.tsx`, `PublicClubBookingPage.tsx` — and no
write path existed for any of the three columns before this phase).

Shape chosen (documented in the RPC migration itself, not just here):

```
tax_info: {
  tax_number: text | null,
  commercial_registration: text | null
}

invoice_settings: {
  trading_name_ar: text | null,
  trading_name_en: text | null,
  address: text | null,
  phone: text | null,
  footer_note: text | null,
  return_policy: text | null
}
```

`logo_url` stays on its own existing top-level column, unchanged.
Every key is optional; an emptied form field is normalized to
Postgres `null` (`nullif(btrim(...), '')`) rather than persisting an
empty string, and `jsonb_strip_nulls` keeps the stored blob free of
null-valued keys entirely — printed documents render only fields that
are genuinely configured (the plan's repeated "never force empty
placeholders" instruction).

### New permission: `shop.settings.manage`

Seeded in `supabase/migrations/20260828140000_shop_print_settings_permission_seed.sql`,
following the exact `shop.discount.apply`/`shop_inventory_permissions_seed`
pattern (key/description insert, `club_owner` grant, `permission_dependencies`
row requiring `shop.view`). Deliberately a **new, distinct** key from
the existing `club.update` permission that already gates the direct
`clubs_update_own_club_owner` RLS policy (club name/timezone/currency
etc.) — per the plan's explicit "new key for clarity" instruction, so
"who can rebrand a club's printed commercial documents" is a
separately grantable capability from "who can change the club's core
settings." Only `club_owner` is granted by default; no other existing
role gets it (branding is an owner-level capability, matching this
codebase's posture on `club.update` itself).

### Settings UI

`ShopSettingsPage.tsx` already existed (confirmed no category/branding
UI lived there before this phase — C1 put category management in
`ShopProductsPage.tsx` instead). Added a new `ShopPrintSettingsSection`
to it: logo upload/replace/remove, trading name (ar/en), address,
phone, tax number, commercial registration, footer note, return
policy. Read via `get_shop_print_settings` (gated on `shop.view` only
— any staff member can preview configured branding, e.g. a cashier
checking Settings), write via `update_shop_print_settings` (gated on
`shop.settings.manage`). Fields render read-only with an explanatory
hint when the current user lacks `shop.settings.manage` (client-side
UX only; the RPC is the real enforcement boundary).

### Logo upload

No logo upload UI existed anywhere in the app before this phase
(confirmed via full `src/` grep — `logo_url` was read-only in
`MembershipCard.tsx`/`PublicClubBookingPage.tsx`). Per the plan's own
instruction ("if no upload UI exists anywhere yet, use the same
shop-product-images-bucket-pattern approach... a new small,
appropriately-scoped bucket or path"), built a **new** bucket
`club-branding` (public, 2MB limit, `{image/jpeg,image/png,image/webp}`)
rather than reusing `shop-product-images` — a club logo is not a
product photo, and gating it on `shop.product.manage` (that bucket's
write permission) would have been semantically wrong now that this
phase introduces `shop.settings.manage` specifically for branding.
Path convention: `{club_id}/branding/{timestamp}-{rand}.{ext}` —
mirrors the existing `{club_id}/{entity_id}/{filename}` convention
(shop-product-images, official-receipts, payment-proofs), with
`branding` as the fixed entity segment since a club has exactly one
logo. Public (same reasoning as `shop-product-images`: a logo is not
sensitive and now needs to render reliably on a printed physical
document, so no signed-URL refresh logic). RLS: SELECT open to anyone
(written explicitly, not relying on the bucket's public flag alone,
matching this project's defense-in-depth convention);
INSERT/UPDATE/DELETE gated on club membership + `shop.settings.manage`
+ `_shop_module_active`. The upload widget itself reuses the exact
`ProductThumb`/upload-button UI pattern C1 built (`shop-media.tsx`),
just pointed at the new bucket/permission — not a second implementation
of the upload UX.

## 2. A4 Invoice, 3. Thermal 80mm Receipt, 4. Payment Receipt

Built as one new file, `src/features/shop/ShopInvoiceDocument.tsx`,
exporting `ShopInvoiceDialog` (invoice/receipt, A4 or 80mm via the
existing toggle) and `ShopPaymentReceiptDialog` (one per `payments`
row). Both reuse `BillingPage.tsx`'s exact print mechanism —
`.print-target[data-print-size]` + `.visible-for-print` +
`window.print()`, the real `@page`/`@page receipt` CSS Paged Media
rules already wired in `src/index.css` — not a second print system.

### RPC changes

- **`get_shop_sale_detail(p_sale_id uuid)`** — extended additively (same
  input signature, `CREATE OR REPLACE` in place) to append a `sku`
  column: `coalesce(v.sku, p.sku)` — a selected variant's own SKU takes
  priority over the parent product's, matching how `unit_price` already
  prefers `variant.price_override` over `product.base_price` elsewhere
  in this module. `shop_products.sku`/`shop_product_variants.sku` both
  already existed (confirmed via direct schema read of
  `20260826210231_shop_catalog_schema.sql`) — this only exposes it on
  an existing read RPC, no new migration needed for the column itself.
- **New `get_shop_sale_invoice_data(p_sale_id uuid)`** — the header/meta/
  payments data neither `get_shop_sale_detail` (items only) nor
  `list_shop_sales` (list-row shape) carry: invoice number, branch,
  location, customer (name + mobile), cashier (`sold_by` → profile
  name), subtotal/discount/total, invoice status, and a `payments`
  jsonb array (one element per `payments` row allocated to the
  invoice: `payment_id`, `amount`, `method`, `reference`, `received_at`,
  `received_by_name`). Reads `invoices`/`payment_allocations`/`payments`
  directly via `shop_sales.invoice_id` (already exists) — matches
  `BillingPage.tsx`'s own established pattern
  (`fetchInvoiceDetail`/`fetchInvoicePayments`) rather than adding new
  denormalized columns to `shop_sales`. One RPC instead of several
  client round-trips since this is a single document render, not a
  paginated list.

Both new/changed RPCs follow the standard Shop write/read-RPC shape:
`auth.uid()`/membership check → `has_permission('shop.view', ...)` →
`_shop_module_active` → query, gated the same way every other Shop read
RPC in this module already is.

### Document content

- **Header**: club logo (only if `logo_url` configured), trading name
  (locale-aware: prefers Arabic name in `ar`, English in `en`, falls
  back to whichever is set), address, phone, tax number/commercial
  registration (only if configured, joined with an em dash only when
  both are present) — every field individually conditional, nothing
  forced.
- **Invoice meta**: invoice number, sale date/time (club-timezone-
  formatted via the existing `formatDate`), branch + location (A4 only
  — omitted on the compact thermal layout), customer name/mobile,
  cashier name (A4 only).
- **Item table**: name (+ variant label), SKU (A4 only — omitted on
  thermal for compactness, matching the plan's "no unnecessary detail,
  fast visual scan" instruction), quantity, unit price, line total.
- **Totals**: subtotal always shown; discount row **only when
  `discount_amount > 0`** (reads `shop_sales.discount_amount`/
  `discount_reason` — C3's own columns, exactly as
  `COMMERCE_C3_CART_PAYMENT_REPORT.md` anticipated this phase would
  need); total always shown; paid **only when > 0**; outstanding
  **only when > 0**.
- **Payments**: every `payments` row allocated to the invoice is
  listed (method + amount) — correctly shows two rows for a C3
  split-tender sale, since `get_shop_sale_invoice_data` aggregates via
  `payment_allocations` rather than assuming one payment per invoice.
  Each payment row also carries a print-hidden "print receipt" link
  that opens `ShopPaymentReceiptDialog` for that specific payment.
- **Footer**: return policy / footer note, only if configured; a
  generic "thank you" line renders only when **neither** is configured
  (so the document is never silently blank at the bottom, but also
  never shows two redundant placeholder-shaped fields).

### Payment Receipt — receipt-number decision

Checked `official_collection_receipts` (government collection
compliance schema,
`20260819200000_government_collection_compliance_schema.sql`) before
inventing anything: it is a distinct, opt-in-per-field/method
government-compliance concept with its own `receipt_serial`/
`normalized_receipt_serial` uniqueness machinery — not a generic Shop
payment receipt scheme, and reusing it here would apply a compliance
concept to something it was never designed for. No other
receipt-numbering concept exists in this codebase for Shop payments.
**Decision**: a payment receipt's identity is the `payments` row's own
`id` (implicitly, via being opened by `paymentId`; not rendered as a
raw UUID on the document) plus `received_at` — sufficient because each
receipt is always shown alongside its linked invoice number, amount,
method, date/time, and collector name, which together uniquely and
humanly identify it. A multi-payment (split-tender) invoice therefore
has multiple receipts — one per `payments` row, exactly per the plan's
instruction — not one per invoice.

## 3. Thermal 80mm receipt

Same `ShopInvoiceDialog`/`InvoiceDocumentBody` component, `printSize
=== '80mm'` branch: smaller text (`text-xs`), SKU column and
branch/location/cashier lines dropped (thermal-inappropriate detail),
otherwise identical data source — no separate fetch, no separate
component. Uses the exact existing `@page receipt` CSS rule (`src/index.css`,
`page: receipt` selector keyed off `data-print-size='80mm'`) — confirmed
present and reused, not reinvented. Reprint is supported directly: the
same dialog is reachable both from the POS post-sale panel (immediately
after checkout) and from `ShopSalesPage.tsx` (any time later, by
clicking a sale's invoice number or its "Invoice" action button) — an
already-completed sale's document is never a one-shot render.

## 4. Wiring into `ShopSalesPage.tsx` / POS post-sale panel

- **`ShopSalesPage.tsx`**: clicking a sale's invoice number (previously
  plain, non-interactive text) or a new explicit "Invoice" action
  button now opens `ShopInvoiceDialog` — closing the gap this phase
  targets (previously only a filtered-table print via
  `ReportPrintButton`/`fetchFullReport`, no real per-sale document).
  The list's own `.print-target.visible-for-print` wrapper (used for
  the "print full report" feature) is now conditional on the invoice
  dialog **not** being open, matching `BillingPage.tsx`'s own
  established pattern of never letting two `.visible-for-print` targets
  coexist in the DOM at once (Radix `Dialog` does not unmount an
  underlying open page when a `Dialog` opens on top of it).
- **`ShopPOSPage.tsx`**: C3 left the post-sale completion panel's
  "print receipt" button linking out to `/app/finance/payments?invoice=...`
  (`BillingPage.tsx`), explicitly documented at the time as an interim
  choice pending this phase. Replaced with two real in-place actions —
  "print receipt" (opens `ShopInvoiceDialog` pre-set to `80mm`) and
  "print invoice" (opens it pre-set to `a4`, using the existing
  `shop.pos.printInvoice` i18n key that had been added but unused since
  an earlier phase) — both backed by the actual sale just completed
  (`sale.saleId`, newly threaded through `CompletedSale`'s state, which
  previously only carried `invoiceId`/`invoiceNumber`). The dialog's own
  A4/80mm toggle still lets the cashier switch either way after
  opening, so this is a sensible default, not a hard split.

Same-DOM-target conflict handled inside `ShopInvoiceDocument.tsx`
itself too: when `ShopPaymentReceiptDialog` opens on top of an already-
open `ShopInvoiceDialog` (via the per-payment "print receipt" link),
the invoice's own print-target drops `.visible-for-print` for as long
as the payment receipt is open, restoring it when the receipt dialog
closes — the same `BillingPage.tsx`-established discipline, applied
here because this phase introduces the first Shop screen with two
nested print-capable dialogs simultaneously mounted.

## 5. Files changed / added

- `src/features/shop/ShopInvoiceDocument.tsx` — new. `ShopInvoiceDialog`,
  `ShopPaymentReceiptDialog`, shared `DocumentHeader`/`PrintSizeControls`/
  `InvoiceDocumentBody`.
- `src/features/shop/ShopSalesPage.tsx` — invoice-number/row click and a
  new "Invoice" action open `ShopInvoiceDialog`; report print-target
  visibility made conditional on that dialog's open state.
- `src/features/shop/ShopPOSPage.tsx` — `SaleCompletePanel` rewired to
  open real documents instead of linking out; `CompletedSale` gained
  `saleId`.
- `src/features/shop/ShopSettingsPage.tsx` — new `ShopPrintSettingsSection`
  (branding form + logo upload).
- `src/lib/i18n/resources/en/common.json`, `ar/common.json` — new
  `shop.invoice.*` namespace, `shop.sales.viewInvoice`, `shop.settings.printSettings*`/
  branding-field keys. Verified programmatically: both files parse as
  valid JSON and the `shop` key sets are set-identical between `en`/`ar`.
- `src/lib/supabase/types.ts` — hand-added type entries (no live DB in
  this worktree to regenerate from, same constraint C1–C3 documented):
  `get_shop_sale_detail`'s new `sku` return field, new
  `get_shop_sale_invoice_data`/`get_shop_print_settings`/
  `update_shop_print_settings` entries.
- `supabase/migrations/20260828140000_shop_print_settings_permission_seed.sql`
  — `shop.settings.manage` permission seed.
- `supabase/migrations/20260828140100_club_branding_storage.sql` —
  `club-branding` bucket + RLS.
- `supabase/migrations/20260828140200_shop_print_settings_rpcs.sql` —
  `get_shop_print_settings`, `update_shop_print_settings`.
- `supabase/migrations/20260828140300_shop_sale_invoice_document_rpcs.sql`
  — `get_shop_sale_detail` SKU extension, new `get_shop_sale_invoice_data`.

### New/changed RPC signatures (exact)

```sql
get_shop_print_settings(p_club_id uuid) returns table(
  logo_url text, tax_number text, commercial_registration text,
  trading_name_ar text, trading_name_en text, address text, phone text,
  footer_note text, return_policy text
)

update_shop_print_settings(
  p_club_id uuid, p_logo_url text default null, p_tax_number text default null,
  p_commercial_registration text default null, p_trading_name_ar text default null,
  p_trading_name_en text default null, p_address text default null,
  p_phone text default null, p_footer_note text default null,
  p_return_policy text default null
) returns void

get_shop_sale_detail(p_sale_id uuid) returns table(
  item_id uuid, product_name_ar text, variant_label text, sku text,
  quantity numeric, unit_price numeric, line_total numeric, returned_quantity numeric
)
-- (sku appended; same input signature, in-place CREATE OR REPLACE)

get_shop_sale_invoice_data(p_sale_id uuid) returns table(
  sale_id uuid, club_id uuid, invoice_id uuid, invoice_number text,
  branch_id uuid, branch_name text, location_name text, customer_id uuid,
  customer_name text, customer_mobile text, sold_by_name text,
  created_at timestamptz, subtotal numeric, discount_amount numeric,
  discount_reason text, total numeric, invoice_status text, payments jsonb
)
```

## 6. Verification performed (evidence tier per item)

- **`npx tsc -b`**: CODE VERIFIED — clean, 0 errors (after fixing one
  real type mismatch: `form.logoUrl || null` doesn't satisfy the RPC
  args' `string | undefined` optional-param typing; changed to
  `|| undefined`, which is also the semantically correct choice —
  PostgREST omits `undefined` fields from the RPC payload entirely, so
  an emptied field correctly falls through to the RPC's own `default
  null`, matching the "clear the field" intent).
- **`npm run lint`**: CODE VERIFIED — 0 errors, 12 pre-existing warnings,
  identical set C1–C3 all documented (`AuthProvider.tsx`,
  `DirectionProvider.tsx`, `PortalClubProvider.tsx`, `badge.tsx`,
  `button.tsx`, `official-collection-receipt-fields.tsx`,
  `QuickBookingSheet.tsx`, `PlatformOwnersPage.tsx`, 3 Supabase Edge
  Functions). Zero new warnings from any file this phase touched.
- **`npm run test -- --run`**: CODE VERIFIED — 99 passed, 95 skipped, 2
  test files fail (`src/App.test.tsx`, `src/lib/domain/billing.test.ts`)
  on `Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY` — confirmed
  this worktree has no `.env.local` (only `.env.example`/
  `.env.e2e.example`), the identical pre-existing environment gap C1–C3
  all documented; not re-investigated as new, per instruction.
- **`npm run test:e2e -- e2e/public e2e/auth e2e/responsive`**: CODE
  VERIFIED — 117 tests, 78 passed, 39 failed, every failure
  `[webkit-desktop]` on a browser-executable-missing error
  (`ms-playwright/webkit-.../Playwright.exe` not installed), on
  marketing/login/route-guard/responsive-viewport pages entirely
  outside the Shop module — identical failure count and root cause to
  C1–C3's own documented results; not re-investigated as new.
- **RPC/permission contract fidelity**: CODE VERIFIED by direct
  migration read — `clubs` table columns (`20260815120000`), `shop_sales`/
  `shop_sale_items`/`payments`/`payment_allocations`/`invoices`/
  `branches`/`customers` schemas, `has_permission`/`_shop_module_active`/
  `write_audit_log`/`write_audit_log_as_support`/`has_platform_support_access`
  signatures, the `shop.discount.apply`/`shop_inventory_permissions_seed`
  permission-seed precedent, `official_collection_receipts`' schema
  (to confirm it's the wrong tool for a generic Shop receipt number),
  and every RPC this phase extends/reads (`get_shop_sale_detail`,
  `list_shop_sales`, `create_shop_sale`) were all read from their real,
  latest migration files before being relied on.
- **No live DB credentials in this worktree** — confirmed (same
  constraint as C1–C3); not worked around. Migration SQL was reviewed
  manually for syntax/logic correctness, including catching one real
  gap during self-review (`update_shop_print_settings` initially
  omitted the `v_via_support`/`write_audit_log_as_support` mirroring
  every other Shop write RPC in this module has — added to match
  `create_shop_sale`'s own established shape before finalizing).
- **Live RLS/RPC calls, browser/UI interaction**: ENVIRONMENT-BLOCKED,
  not LIVE VERIFIED / BROWSER VERIFIED — same three blockers C1–C3 all
  documented (no `.env.local`, no Docker-backed local Supabase stack,
  and creating a Supabase branch for a disposable test is a material
  paid-service change requiring explicit user go-ahead, not taken
  unilaterally). Recommendation unchanged: approve a Supabase branch
  for a real impersonation/print-flow test, or run the equivalent from
  a session with real credentials/local stack.
- **Print CSS/A4/80mm mechanism**: CODE VERIFIED by direct reuse — no
  new CSS was written; `data-print-size`/`.print-target`/
  `.visible-for-print` are the exact existing selectors from
  `src/index.css`, confirmed present and unmodified.

## 7. Deliberate scope boundaries (not omissions)

- No new `shop_print_*` columns were added — the corrected plan's
  instruction to reuse `clubs.tax_info`/`invoice_settings` was followed
  exactly; nothing in the plan's §14 field list needed a column outside
  either jsonb blob or the existing `logo_url`.
- `official_collection_receipts` was deliberately **not** reused or
  extended for Shop payment receipts — it is a different, government-
  compliance-specific concept (see Section 4 above); inventing a
  parallel numbering scheme or forcing this system into that one would
  both have been wrong. The `payments.id`/`received_at` decision is
  documented, not silent.
- A discount-limit/max-discount-threshold system remains out of scope
  (unchanged from C3 — `shop.discount.override_limit` stays seeded but
  unused; this phase doesn't touch discount logic at all beyond
  rendering C3's existing `discount_amount`/`discount_reason` on the
  printed document).

## 8. Commit

Committed locally to this worktree's own branch
(`worktree-agent-a7ab9225d43599675`) — no push, no merge, no
interaction with `main`, per `AGENT_ORCHESTRATION_GOVERNANCE.md`. Exact
commit SHA and clean-tree confirmation reported to the orchestrator
directly (outside this file) after the commit is made.
