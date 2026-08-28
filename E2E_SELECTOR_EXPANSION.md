# E2E Selector Expansion

Follow-up phase to `E2E_TEST_STRATEGY.md`'s own "Recommended next step":
adds `data-testid` coverage to the highest-value interactive elements
named there, and upgrades the corresponding `test.fixme()` specs into
real, deep-assertion tests wherever the new selectors genuinely make
that possible. Written 2026-08-28, in an isolated worktree
(`worktree-agent-a6758a15f1d5752f7`) per `AGENT_ORCHESTRATION_GOVERNANCE.md`
-- no push attempted, everything below is committed locally only.

## Evidence taxonomy used below

- **CODE VERIFIED** -- the selector exists in the real component source
  (grep-confirmed, not guessed), the spec type-checks and lints
  cleanly, and the test logic was reasoned through against the actual
  source of the component it drives.
- **LIVE VERIFIED** -- actually executed against the real local dev
  server talking to the real live Supabase backend, in this session,
  with a real pass/fail result reported below.

No authenticated spec in this repository can be LIVE VERIFIED in this
environment: `SUPABASE_SERVICE_ROLE_KEY` is not available, so
`npm run e2e:setup` cannot mint any `e2e/.auth-state/*.json` session,
so every `test.skip(!hasMintedSession(...))` guard in `e2e/staff/**`
and `e2e/portal/**` skips cleanly rather than running -- exactly the
same constraint `E2E_TEST_STRATEGY.md` already documents. This phase
did not attempt to work around that (and could not, per this session's
own instructions).

## Part 1 -- `data-testid` attributes added

Purely additive HTML attributes; no styling, behavior, or existing
test's pass/fail status was changed. Confirmed via `npx tsc -b` (clean)
and `npm run lint` (0 errors, same 12 pre-existing warnings as
`main`, none introduced by this change) after every edit below.

### Booking (`src/features/bookings/`)

| File | Element | `data-testid` |
|---|---|---|
| `QuickBookingSheet.tsx` | duration `SelectItem`s | `quick-booking-duration-{value}` (e.g. `-1`, `-1.5`) |
| `QuickBookingSheet.tsx` | confirm/book button | `quick-booking-confirm` |
| `BookingsFieldDayView.tsx` | available-slot button (single-field desktop view) | `booking-slot-{fieldId}-{HH:MM}` |
| `BookingsMobileView.tsx` | available-slot button (mobile view) | `booking-slot-{fieldId}-{HH:MM}` |
| `BookingsPage.tsx` | available-slot grid cell (all-fields desktop view) | `booking-slot-{fieldId}-{HH:MM}` |

`QuickBookingSheet` itself only renders duration/confirm controls --
the actual "click an empty slot" action that opens it lives in the
three calendar view components above (confirmed by reading all of
`BookingsPage.tsx`, `BookingsFieldDayView.tsx`, and
`BookingsMobileView.tsx`, since `onSlotSelect`/`setSlotSelection` is
wired from three separate places, not one). All three now carry the
same `booking-slot-{fieldId}-{HH:MM}` id shape so a spec can target a
slot without depending on translated day/time copy.

### Printing / Invoices (`src/features/billing/BillingPage.tsx`)

| Element | `data-testid` |
|---|---|
| Invoice number link in the invoice list (opens invoice detail) | `invoice-row-{invoiceId}` |
| Invoice detail's printable root (`.print-target[data-print-size]`) | `invoice-print-view` |
| Invoice print-size `SelectTrigger` | `invoice-print-size-toggle` |
| Invoice print-size `SelectItem`s | `invoice-print-size-a4`, `invoice-print-size-80mm` |
| Refund trigger button (per payment) | `refund-payment-{paymentId}` |
| Refund amount / reason inputs | `refund-amount-input`, `refund-reason-input` |
| Refund submit button | `refund-submit` |
| Refund receipt's printable root | `refund-receipt-view` |
| Payment receipt's printable root | `payment-receipt-view` |

**Correction found while reading `src/index.css` for this task**:
`E2E_TEST_STRATEGY.md` and the original `printing.spec.ts` both
reference `#invoice-print[data-print-size]` as the print-CSS target.
That id no longer exists -- `src/index.css`'s own comment documents
that task #85 deliberately replaced it with a `.print-target[data-print-size]`
**class** selector, because the refund-receipt dialog added a second
printable surface that can be mounted in the DOM at the same time as
the invoice-detail dialog underneath it (two elements sharing one `id`
would be invalid HTML). This phase's `data-testid="invoice-print-view"`
sits on the real element; the spec and its header comment have been
corrected to describe the actual selector instead of repeating the
stale one.

### Academy Enrollment (`src/features/academy/EnrollmentSection.tsx`)

| Element | `data-testid` |
|---|---|
| "New enrollment" trigger | `enrollment-wizard-open` |
| Player / guardian / group `SelectTrigger`s | `enrollment-wizard-player`, `-guardian`, `-group` |
| Player / guardian / group `SelectItem`s | `enrollment-wizard-player-{id}`, `-guardian-{id}`, `-group-{id}` |
| Submit button | `enrollment-wizard-submit` |
| Error/rejection surface (`role="alert"`, populated by `enrollMutation.onError`) | `enrollment-wizard-error` |

Confirmed by reading `enrollMutation`'s definition that
`enrollment-wizard-error` is exactly the surface a server-side
rejection (including a full-capacity rejection from
`create_enrollment_with_subscription`) renders through --
`translateSupabaseError(error, ...)` feeds directly into `wizardError`.

### Shop Stock Count (`src/features/shop/ShopStockCountPage.tsx`)

| Element | `data-testid` |
|---|---|
| "Start new" button (list page) | `stock-count-start-new` |
| Open/continue button per row | `stock-count-open-{id}` |
| Start dialog: location `SelectTrigger`/`SelectItem`s, notes input, confirm | `stock-count-location`, `stock-count-location-{id}`, `stock-count-notes`, `stock-count-start-confirm` |
| Detail dialog: add-product/-variant `SelectTrigger`/`SelectItem`s, add-line button | `stock-count-add-product(-{id})`, `stock-count-add-variant(-{id})`, `stock-count-add-line` |
| Per-line counted-quantity input | `stock-count-line-counted-{itemId}` |
| Complete / cancel buttons | `stock-count-complete`, `stock-count-cancel` |
| Status badge | `stock-count-status`, plus a new `data-status="{status}"` attribute for a copy-independent status assertion |

The `data-status` attribute on the status badge is a second additive
attribute (not requested verbatim by the task, but the same spirit as
`data-print-size` already used elsewhere in this codebase) -- it lets a
test assert `completed`/`in_progress`/`cancelled` without depending on
the Arabic/English translated label, which is exactly the fragility
`E2E_TEST_STRATEGY.md`'s selector-strategy section warns about.

All wrapped shadcn/Radix primitives used above (`Button`, `Input`,
`Badge`, `SelectTrigger`, `SelectItem`) were confirmed by reading their
source (`src/components/ui/*.tsx`) to spread `...props` onto the real
underlying DOM/Radix element, so `data-testid` passes through
correctly in every case above.

## Part 2 -- spec changes

### `e2e/staff/booking.spec.ts`

- **Timezone regression guard**: now a real test (no longer
  `test.fixme()`) that opens `QuickBookingSheet` from the first
  available `booking-slot-*` control and asserts the sheet's summary
  line echoes back the exact same `HH:MM` that was clicked -- the
  DOM-visible half of D-001's regression class. **Still cannot fully
  close the original gap**: the real P0 was a drift in the *stored*
  `timestamptz` value written by `create_booking`'s RPC call, not the
  client-echoed summary text, and Playwright has no way to read back
  the actual Postgres row without a `service_role`-gated query (a
  different, new scope decision this phase did not take). Narrowed
  from "no selectors exist" to a real, smaller, disclosed gap; the
  test itself is real and CODE VERIFIED, its DOM-visible assertion
  will run once a session is minted.
- **Field-block conflict scenario**: **left `test.fixme()`, on purpose,
  with a materially different and more accurate reason than before**.
  A repo-wide search this phase confirmed `create_field_block` (the
  RPC that would create the conflicting block) has zero callers
  anywhere in `src/**/*.tsx` -- every reference to field blocks in the
  bookings feature is read-only display code. There is currently **no
  UI control to create a field block at all**, so no `data-testid`
  could unblock this regardless of how much selector coverage was
  added -- the gap is a missing feature, not a missing selector. The
  spec's comment now says this explicitly instead of repeating the
  original selector-stability framing, which would have been
  misleading now that selectors do exist elsewhere in this same file's
  neighborhood.

### `e2e/staff/printing.spec.ts`

- **Print-size toggle**: now a real test. Opens the first invoice row,
  asserts the print view's `data-print-size` starts at `a4` (the
  `useState` default), toggles to `80mm` via the new
  `invoice-print-size-toggle`/`-80mm` testids and asserts the attribute
  actually changes, then toggles back to `a4` to prove it's genuinely
  reactive in both directions. Self-skips (`test.skip`, not a false
  pass) if the QA fixture club has no invoices to open.
- **Refund receipt view**: now a real test. Opens the first invoice,
  clicks the first `refund-payment-{id}` button found, fills a real
  amount/reason, submits (a real `create_refund` RPC call against the
  live backend -- same "real backend, always" philosophy as every
  other spec in this suite), then asserts `refund-receipt-view` is
  visible, carries `data-print-size="a4"`, and contains the exact
  reason text just submitted (proving it's rendering the just-created
  refund's data, not a stale view). Self-skips if there's no invoice or
  no refundable payment in the fixture data.
- Both tests, plus the file's header comment, were corrected for the
  `#invoice-print` → `.print-target[data-print-size]` selector drift
  described above.

### `e2e/staff/academy-memberships.spec.ts`

- **Capacity rejection**: now a real test, with an honestly-scoped
  claim. `EnrollmentSection.tsx`'s own `fetchGroups()` has **no
  client-side capacity filtering at all** (confirmed by reading it) --
  the wizard lets staff pick any active group and relies entirely on
  `create_enrollment_with_subscription` to reject it server-side. That
  means this test cannot deliberately target a group already at
  capacity by selector or label; it drives the wizard with whatever
  player/guardian/group the live fixture data exposes first and
  asserts that **if** the server rejects the submission, the rejection
  reaches the user as a real, visible, non-empty `enrollment-wizard-error`
  rather than a silent failure or a false-success dialog close. This is
  disclosed directly in the spec's comment rather than overclaiming
  "capacity rejection" coverage the test can't actually guarantee on
  every run. The authoritative proof of the capacity rule itself
  remains this project's own RPC-level integration coverage
  (`docs/PROJECT_STATE.md` Phase 11 exit gate) -- unchanged by this
  phase.

### `e2e/staff/shop-stock-count.spec.ts`

- **Stock count session**: now a real test (no longer `test.fixme()`),
  rewritten from the original draft's literal-Arabic-text selectors
  (`getByRole('button', { name: 'بدء عملية جرد' })`, fragile exactly per
  `E2E_TEST_STRATEGY.md`'s own warning) to the new `data-testid`
  coverage. Drives the full lifecycle: start dialog -> pick a location
  -> confirm -> add a product line -> enter a deliberate variance
  (`999999`, guaranteed not to match any real system quantity) ->
  complete -> assert `stock-count-status` carries `data-status="completed"`
  -> assert the complete/cancel controls are gone afterward (the UI's
  own guarantee against a duplicate completion, since
  `ShopStockCountPage.tsx`'s `isInProgress` gate removes both controls
  once `completed`). Self-skips if the fixture club has no inventory
  location or no active product. This is **CODE VERIFIED, not LIVE
  VERIFIED** -- same credential constraint as everything else in
  `e2e/staff/**`.

## What's genuinely still `test.fixme()`, and why

Only one test remains deferred for a selector-availability reason, and
it is now a *smaller* gap than before:

- **Field-block conflict** (`booking.spec.ts`) -- blocked on a missing
  UI feature (no field-block-creation control exists), not a missing
  selector. Unblocking this for real needs either building that UI, or
  creating the conflicting block directly via RPC/DB as a
  `service_role`-gated test-setup step (the same category of blocker as
  `e2e/setup/mint-qa-sessions.ts` itself).

The timezone regression guard is real and DOM-verifiable for its
client-echo half; its stored-instant half remains out of reach for the
reason explained above (no server-side read capability in this suite),
which is disclosed in the test's own comment rather than silently
dropped.

## Live results -- zero-credential suites (LIVE VERIFIED)

Executed this phase, for real, against the real local Vite dev server
talking to the real live Supabase project:

```
npx playwright test e2e/public e2e/auth e2e/responsive --project=chromium-desktop
```

**Result: 39 passed, 0 failed** (24.8s). Matches
`E2E_TEST_STRATEGY.md`'s own prior baseline (19 public-pages + 20
responsive, route-guards counted within the auth spec file) -- these
selector/spec changes did not touch any zero-credential spec and did
not regress this suite.

## What remains CODE VERIFIED only (not run)

Every `e2e/staff/**` spec, including all four files touched this
phase -- blocked on `SUPABASE_SERVICE_ROLE_KEY` not being available in
this environment, exactly as `E2E_TEST_STRATEGY.md` describes for the
whole authenticated suite. Verified short of live execution:

- `npx tsc -b` (project-wide build graph, includes `tsconfig.e2e.json`) -- clean, 0 errors.
- `npx tsc -p tsconfig.e2e.json --noEmit` (e2e specs directly) -- clean, 0 errors.
- `npm run lint` -- 0 errors, the same 12 pre-existing warnings present on `main`, none introduced by this change.
- Every `data-testid` referenced by the updated specs was grep-confirmed to exist in the real component source (see the tables in Part 1) -- not guessed from a decision-log description.

Do not read "CODE VERIFIED" above as "tests now pass" -- these
authenticated specs have never been executed end-to-end in this
engagement. The next session with a real `service_role` key should run
`npm run e2e:setup` once, then `npm run test:e2e`, and report the real
pass/fail/skip counts for `e2e/staff/**`.
