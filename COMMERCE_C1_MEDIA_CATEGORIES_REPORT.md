# Commerce Pro — Phase C1 Report: Product Media + Category UX

Written 2026-08-28, by the C1 subagent (isolated worktree
`worktree-agent-a2f37f57b522b4695`), per `COMMERCE_PRO_UPGRADE_PLAN.md`
Section 5 and `AGENT_ORCHESTRATION_GOVERNANCE.md`. Scope: Product Media
+ Category UX only. `ShopPOSPage.tsx` was not touched, as instructed —
that is Phase C2.

## 1. What was built

### Storage bucket
- New bucket `shop-product-images`: **public**, 5MB file size limit,
  MIME types `{image/jpeg, image/png, image/webp}` only.
- Path convention: `{club_id}/{product_id}/{filename}` for products,
  `{club_id}/categories/{category_id}/{filename}` for categories
  (documented in code comments; consistent within each entity type).
- RLS on `storage.objects`: SELECT open to anyone (written as an
  explicit policy, not left to implicit public-bucket behavior, per
  this project's defense-in-depth convention). INSERT/UPDATE/DELETE
  gated on `(storage.foldername(name))[1]::uuid in (select
  public.user_club_ids())` AND `has_permission('shop.product.manage',
  ...)` AND `public._shop_module_active(...)` — the module-active gate
  was added beyond the plan's literal instruction because every other
  Shop write path (RPCs, table RLS) already enforces it, and omitting
  it here would have been the exact class of gap the project's own
  `20260828083000_shop_read_rpcs_enforce_module_active.sql` /
  `20260828085500_...` migrations were written to close.

### Schema (all additive)
- `shop_products.image_urls jsonb not null default '[]'::jsonb` —
  ordered array of additional image URLs. `image_url` (existing
  singular column) remains the primary image, unchanged.
- `shop_categories.image_url text`, `shop_categories.display_order
  integer not null default 0`.
- `parent_category_id` was **deliberately NOT added**. The plan flags
  it as optional/speculative, to be added only on a genuine concrete
  need found while building the UI. Building the category management
  UI and reasoning about the POS category strip (Phase C2's own scope,
  not built here) surfaced no real requirement for nested categories —
  a flat list with `display_order` fully covers both this phase's
  management UI and a single-level POS chip strip. Skipped as
  instructed, stated explicitly here.

### Migrations (in order)
1. `supabase/migrations/20260828100000_shop_product_images_storage.sql`
   — bucket + RLS policies.
2. `supabase/migrations/20260828100100_shop_product_media_category_ux_schema.sql`
   — the four new columns above.
3. `supabase/migrations/20260828100200_shop_product_media_category_ux_rpcs.sql`
   — RPC updates (below).

### RPC signature changes
Every function body was copied **verbatim** from its current live
definition (confirmed by reading the actual latest migration for each
function — `20260828095000_shop_final_module_active_sweep.sql` for
`update_shop_product`, `20260826230658_shop_category_product_support_audit.sql`
for `create_shop_category`/`create_shop_product`,
`20260828080000_shop_category_update_rpc.sql` for
`update_shop_category`, `20260828083000_shop_read_rpcs_enforce_module_active.sql`
for the read RPCs) before adding only the new fields. Auth checks,
`_shop_module_active` gates, and `write_audit_log_as_support` mirroring
are preserved exactly — not weakened or restructured.

- `create_shop_product(...)` — appended `p_image_urls jsonb default
  '[]'::jsonb`. Old 11-arg overload dropped; new 12-arg one granted to
  `authenticated` only.
- `update_shop_product(...)` — appended `p_image_urls jsonb default
  null` (null = "leave unchanged", matching every other optional field
  in this function's existing `coalesce`-based update pattern). Old
  11-arg overload dropped.
- `create_shop_category(...)` — appended `p_image_url text default
  null`, `p_display_order integer default 0`. Old 3-arg overload
  dropped.
- `update_shop_category(...)` — appended `p_image_url text default
  null`, `p_display_order integer default null`. Old 4-arg overload
  dropped.
- `list_shop_products(...)` — same input signature (in-place replace,
  no new overload), return row gains `image_urls jsonb`.
- `list_shop_categories(...)` — same input signature, return row gains
  `image_url text`, `display_order integer`; now orders by
  `display_order, name_ar` (falls back to alphabetical for any
  category still at the default order 0, so no ordering regression for
  existing categories).
- `list_shop_categories_all(...)` — same additions as above, orders by
  `display_order, status, name_ar`.

Every dropped/replaced overload was verified against the actual
current grants so PostgREST is left with exactly one live signature
per RPC name — no orphaned overloads, matching this project's own
established practice (e.g.
`20260826235307_drop_orphaned_return_shop_sale_overload.sql`).

### Frontend — `src/features/shop/ShopProductsPage.tsx` (fully rebuilt)
- **Image upload**: `PrimaryImageUploader` (single primary image, with
  replace/remove) and `GalleryImagesUploader` (ordered array of
  additional images, add/remove) — both upload directly to
  `shop-product-images` via `supabase.storage.from(...).upload()`,
  tenant-scoped by the club-id-prefixed path, and hand the resulting
  public URL back to the form state; the RPC call on submit is what
  actually persists it. Client-side validates MIME type and 5MB limit
  before upload (with server-side enforcement as the real boundary via
  the bucket's own `file_size_limit`/`allowed_mime_types`).
- **Thumbnail with real fallback**: `ProductThumb` renders the `<img>`
  when a URL is set and hasn't errored; otherwise (or on `onError`)
  renders `ImagePlaceholder` — a neutral box with a `lucide-react`
  `ImageOff` icon, not a browser broken-image icon.
- **No layout jump**: every thumbnail slot is `aspect-square` (grid
  cards) or a fixed `size-*` box (table/list rows, gallery chips) —
  the box exists before the image loads, so nothing reflows once it
  does.
- **Lazy loading**: every `<img>` sets `loading="lazy"`.
- **Grid / list toggle**: `ProductGrid` (image-forward cards, 2–5
  columns responsive) and the pre-existing `DataTable` (now with an
  added image column). Toggle state persists to `localStorage`
  (`mala3by.shop.productsViewMode`) so the user's choice survives a
  reload.
- **Grid card / list row fields**: image, Arabic name, English name
  (if set, shown as secondary text), category, SKU, barcode
  (list view; grid shows whichever of SKU/barcode is present),
  selling price (`MoneyDisplay`), stock (best-effort aggregate, see
  below), low-stock badge, active/archived status badge, variant
  count (list view, lazily fetched per-row) / manage-variants link
  (grid view).
- **Cost/margin — honestly omitted, not fabricated**: confirmed by
  reading the schema that `unit_cost` exists **only** at
  `shop_inventory_movements` level (set on `receive_shop_stock`), never
  as a stable per-product cost column, and there is no
  cost-at-sale snapshot yet (that is a later-phase item per the plan,
  `shop_sale_items.unit_cost_snapshot`, not built in C1). Computing a
  "cost" from raw movement rows here would mean guessing at a costing
  method (FIFO/weighted-average/last-cost) this page has no mandate to
  decide, so cost and margin are **not shown anywhere** on this page —
  matching the plan's own "never fabricate" instruction.
- **Stock (aggregate across locations)**: `fetchStockByProduct` calls
  `get_shop_inventory_balances(club_id)` and sums `on_hand` per
  `product_id` across every location/variant. This requires
  `inventory.view`, a permission distinct from `shop.product.manage`
  (per the permission-dependency seed, `shop.product.manage` only
  requires `shop.view`). If the call fails (e.g. a role with
  `shop.product.manage` but not `inventory.view` — a real, intentional
  combination the permission matrix allows), the page renders `—` for
  every product's stock rather than surfacing a page-level error or a
  false "0 in stock" — stock is an enrichment on this page, not its
  core purpose, and a permission gap here must not block product
  management.
- **Category management** (`ManageCategoriesDialog`, already living in
  this same file, not `ShopSettingsPage.tsx` — confirmed no category UI
  exists there): name (ar edit; en shown via the existing
  create-category flow), image upload (uploads to
  `{club_id}/categories/{category_id}/{filename}`), display-order
  up/down buttons (no drag library — a small, typically single-digit
  category list doesn't need one, and up/down buttons are simpler to
  keep keyboard-accessible correctly), active/archive toggle (existing
  behavior, unchanged).

### i18n
Added to both `src/lib/i18n/resources/en/common.json` and
`src/lib/i18n/resources/ar/common.json`, under the existing `shop.*`
structure: `shop.products.columns.{barcode,stock,variants}`,
`shop.products.{viewGrid,viewList,primaryImageLabel,lowStock,stockCount}`,
`shop.categories.{moveUp,moveDown}`, and a new `shop.media.*`
namespace (`uploadImage`, `replaceImage`, `removeImage`, `uploading`,
`uploadError`, `invalidType`, `tooLarge`, `fileHint`, `galleryLabel`).
Both JSON files validated to parse correctly after editing.

## 2. Verification performed

- **`npx tsc -b`**: clean, 0 errors (confirmed after fixing one real
  `noUncheckedIndexedAccess` issue in the category reorder buttons —
  guarded the possibly-`undefined` neighbor lookup before use).
- **`npm run lint`**: 0 errors, 12 pre-existing warnings (verified none
  are in any file this phase touched — all 12 are in files this phase
  never edited: `AuthProvider.tsx`, `DirectionProvider.tsx`,
  `PortalClubProvider.tsx`, `badge.tsx`, `button.tsx`,
  `official-collection-receipt-fields.tsx`, `QuickBookingSheet.tsx`,
  `PlatformOwnersPage.tsx`, and 3 Supabase Edge Functions). Zero new
  warnings introduced.
- **`npm run test -- --run`**: 99 tests pass, 95 skipped (pre-existing
  skip reasons unrelated to this change), 2 test files fail —
  `src/App.test.tsx` and `src/lib/domain/billing.test.ts`, both on
  `Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY` because this
  worktree has no `.env.local`. Confirmed via `git stash` that these
  exact 2 files fail identically **before** any of this phase's
  changes — pre-existing environment gap in this worktree, not a
  regression from this work.
- **No existing Shop test/spec broke**: no unit/integration test
  targets `ShopProductsPage.tsx` today (confirmed via search — the
  only Shop-adjacent spec is `e2e/staff/shop-stock-count.spec.ts`,
  unrelated to this page). The zero-credential E2E suite's own
  `.env.e2e.example` shows it requires a real `SUPABASE_SERVICE_ROLE_KEY`
  to mint QA sessions (`npm run e2e:setup`) — not runnable in this
  credential-less worktree, so it was not run (see ENVIRONMENT-BLOCKED
  note below, same root cause as the RLS test).

## 3. Live RLS test — ENVIRONMENT-BLOCKED, not LIVE VERIFIED

The plan requires a real `set_config('request.jwt.claims', ...)` +
`set local role authenticated` impersonation test proving (a) a club's
own authorized user CAN upload/read within their own club path and (b)
a different club's user CANNOT write into the first club's path.

This was **not performed**, and is reported honestly as
ENVIRONMENT-BLOCKED rather than claimed:

- This worktree has no `.env`/`.env.local` (only `.env.example` /
  `.env.e2e.example` templates) — no credentials for any Supabase
  project.
- Docker Desktop is not available in this environment (`supabase
  status` fails with a docker-daemon connection error), so `supabase
  start` (the local stack needed for a safe, disposable impersonation
  test) cannot run.
- The only reachable Supabase project via the available MCP tooling is
  `gxkrtlvpjwxhcqdisyob` ("mal3abyapp-oss's Project") — the real
  linked project for this repository, not a disposable sandbox.
  Running `apply_migration`/`execute_sql` DDL or impersonation queries
  directly against it from an isolated worktree subagent, without
  explicit orchestrator/user review first, is not this subagent's call
  to make unilaterally on a shared database.
- Supabase branching (`create_branch`) would have created a genuinely
  safe, isolated, non-production database for exactly this kind of
  test — but branch creation has a real recurring cost, making it a
  material paid-service change that requires the user's explicit
  go-ahead, not something to spin up unilaterally mid-task.
  `list_branches` was checked first (confirmed empty — no pre-existing
  branch to reuse) before deciding not to create one without approval.

**What this phase's RLS/RPC work IS backed by**: CODE VERIFIED only —
every new policy and RPC follows the exact structural pattern of an
already-live, already-proven policy/RPC in this codebase
(`official-receipts` bucket policies for the storage RLS shape;
`update_shop_category`/`create_shop_product`'s own current bodies,
read directly from their latest migrations, for the RPC auth/audit
shape), and `npx tsc -b`/`npm run lint` confirm the generated-types
contract this frontend relies on is internally consistent. This is
real evidence of internal consistency and pattern-fidelity, but it is
explicitly **not** equivalent to an actual live cross-tenant denial
test, and is not represented as one.

**Recommendation for the orchestrator**: if a live RLS test is
required before this phase is considered fully verified, either (a)
grant explicit approval to create a Supabase branch for a real,
disposable impersonation test, or (b) run the equivalent test from a
session that already has this repo's real `.env.local` / Docker-backed
local stack available.

## 4. Deliberate scope boundaries (not omissions)

- `ShopPOSPage.tsx` was not opened for editing at any point in this
  session, per the explicit instruction that the POS rebuild is Phase
  C2's scope. The new `list_shop_products`/`list_shop_categories`
  return-shape additions are backward compatible with
  `ShopPOSPage.tsx`'s existing field-by-name consumption (confirmed by
  reading its current `list_shop_products` call site), so C2 can
  consume the new `image_urls`/`display_order`/category `image_url`
  columns without any C1-side follow-up.
- `parent_category_id` intentionally not added (Section 1 above).
- Cost/margin intentionally not shown (Section 1 above).

## 5. Commit

Committed locally to this worktree's own branch
(`worktree-agent-a2f37f57b522b4695`) — no push, no merge, no
interaction with `main`, per `AGENT_ORCHESTRATION_GOVERNANCE.md`. Exact
commit SHA and clean-tree confirmation are reported back to the
orchestrator directly (outside this file) after the commit is made.
