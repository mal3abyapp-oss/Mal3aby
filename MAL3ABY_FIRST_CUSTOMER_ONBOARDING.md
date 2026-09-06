# Mal3aby — First Customer Onboarding (Operational Runbook)

Written 2026-09-06, Final Sell-Readiness Mission. This is the operator
(non-technical, Platform Owner) runbook for onboarding the first, and every
subsequent, real paying customer. It complements — and does not replace —
`FIRST_CUSTOMER_ONBOARDING_RUNBOOK.md` and `TENANT_GO_LIVE_CHECKLIST.md`,
which already cover the platform-owner-side "create the tenant, staff it,
verify isolation" checklist in full detail. This document adds what those
two did not have available at the time they were written: the real
self-serve signup wizard's exact steps, and an explicit confirmation that
the trial-start bug found and fixed this session no longer blocks this
flow.

**Read this first if you have not read the other two.** This document is
written to stand alone, but if a step below says "see X," X has the
authoritative detail.

## Important fact this runbook depends on

The self-serve onboarding wizard (`src/features/onboarding/OnboardingPage.tsx`)
calls two RPCs in sequence: `complete_new_club_onboarding()` (creates the
club, branch, owner membership, and default modules) and then
`mark_club_onboarding_complete()` (starts the trial). Until 2026-09-06,
the second call was never made anywhere in the frontend — every self-serve
signup created a real club and then instantly locked the new owner out
with no trial ever started (`get_club_platform_access()` returns `blocked`
for a club with zero `platform_subscriptions` rows). **This is now fixed**
(see `MAL3ABY_FINAL_SELL_READINESS.md` for the full root-cause writeup) and
verified live. It is safe to send a real customer through self-serve signup
as of this commit. If you are onboarding a customer through the **sales
conversion path** instead (an invited prospect converting from the Sales
Intelligence module), the equivalent fix was made server-side in
`_complete_sales_conversion` via
`supabase/migrations/20260906080000_fix_sales_activation_never_starts_trial.sql`,
also applied and verified live — that path is safe too.

## PRE-DEMO

- [ ] Confirm you are logged in as Platform Owner on `https://mal3aby.app`
      and the browser console build tag matches the currently deployed
      commit (see `PRODUCTION_OPERATIONS_DR_ACCEPTANCE.md` for how to
      check this, or `INCIDENT_RUNBOOKS.md`'s DEPLOY runbook step 8).
- [ ] Have the prospect's real business name (Arabic and, if they want
      one, English), city, and a real contact phone number ready.
- [ ] Decide, before the call, whether this business is government/
      ministry-affiliated (asked as a yes/no question in the wizard) —
      it changes nothing about onboarding difficulty, but get the answer
      right the first time since it affects official-receipt handling
      downstream.

## DEMO

Run the actual sales demo using the existing demo tenant, not the
prospect's real (not-yet-created) account. See
`MAL3ABY_10_MINUTE_DEMO_RUNBOOK.md` for the full script.

## ACCOUNT CREATION

There are two real paths into the product. Use whichever matches how this
customer actually came in.

### Path A — Self-serve signup (the ordinary path)

1. The prospect (or you, on their behalf) signs up / logs in with a real
   email address at `https://mal3aby.app`, then is routed to the
   onboarding wizard.
2. **Step 1 — Business type.** One of: نادي (club), أكاديمية (academy),
   ملاعب (fields), مركز رياضي (sports center). This value is stored as
   entered and does not need to be perfectly precise — it is descriptive,
   not a hard product-mode switch.
3. **Step 2 — Basic details.** Arabic club name (required) and English
   club name (optional). Enter the real business name exactly as the
   customer wants it to appear — this shows up on customer-facing
   invoices/receipts later, so get it right here rather than renaming it
   after real transactions exist.
4. **Step 3 — First branch + contact + government-affiliation.** Real
   branch name, real city, a real phone number (validated and normalized
   to E.164 at this step — an invalid number blocks submission), and the
   government-affiliation yes/no answer. All fields here are required
   before the wizard lets you submit.
5. Submitting step 3 calls `complete_new_club_onboarding()` (creates the
   club, the branch, the owner's membership, and default modules) and
   then, automatically, `mark_club_onboarding_complete()` (starts the
   trial). Both happen in one submit — there is no separate button for
   the second call.
6. **Step 4 — Confirmation screen.** Shows one of two messages:
   - **Trial activated** — the normal, expected outcome for this owner's
     first-ever club.
   - **No trial granted** — this specifically means this owner already
     has an automatic-trial entitlement claimed on another club (the
     product allows exactly one automatic trial per owner, by design,
     not a bug). If you see this for what should be a genuinely first-time
     owner, stop and check `automatic_trial_entitlements` for that
     `auth.uid()` before proceeding — do not assume it is safe to
     continue without understanding why.
7. From here, follow `FIRST_CUSTOMER_ONBOARDING_RUNBOOK.md` steps 4
   onward (confirm tenant status is `active`, set subscription tier if
   different from the trial default, create additional branches/staff/
   fields/academy groups/pricing, etc.) and complete every gate in
   `TENANT_GO_LIVE_CHECKLIST.md` before telling the customer they are
   live.

### Path B — Sales-conversion (an invited prospect from the Sales
Intelligence module converting to a tenant)

Follows the same trial-start guarantee via `_complete_sales_conversion`
(fixed server-side, see above). The rest of setup and go-live is identical
to Path A from the point the club exists — proceed with
`FIRST_CUSTOMER_ONBOARDING_RUNBOOK.md` and `TENANT_GO_LIVE_CHECKLIST.md`.

## SETUP

Complete each of the following before go-live. These mirror
`TENANT_GO_LIVE_CHECKLIST.md`'s gates — use that checklist as your actual
tracking sheet; the notes below are the "why" behind each item as it
applies to this mission's findings.

- **Branch(es)**: real name/address, correct currency, correct timezone,
  correct operating hours. The onboarding wizard only creates the first
  branch — add any others through the normal branch-management screen.
- **Fields**: real courts/fields matching the customer's actual physical
  setup, with real hourly pricing (never leave QA placeholder pricing
  like 1 EGP/hour live for a real tenant).
- **Academy** (if this customer runs one): real programs/groups. If this
  club will run fields and academy together (four real production clubs
  already do this successfully), the double-booking gap that would have
  made this unsafe is now fixed and verified live — see
  `MAL3ABY_FINAL_SELL_READINESS.md`'s Academy section.
- **Staff**: one real person per account, invited via the platform's
  staff-invitation flow, never a shared login. Assign real roles/
  permissions matching what this person actually does — do not grant
  broader access "to be safe."
- **Permissions**: use the existing role/permission screen to confirm
  each staff member's assigned role grants exactly what their job
  requires. If this customer needs a custom role (not one of the
  built-in ones), be aware the coach-custom-role dashboard routing bug
  was found and fixed this session (`TodayPage.tsx`) — a custom role
  scoped only to coach-like permissions should now route correctly.
- **Public booking page** (if the customer's plan includes it): confirm
  it loads and shows only this tenant's real courts/pricing, not any
  other tenant's or QA data.
- **Customer portal**: confirm a real customer can self-register/claim
  their own record without seeing any other tenant's data (portal
  cross-persona isolation was live-adversarially tested and confirmed
  safe this session).
- **Payment settings**: configure the real payment methods this customer
  actually accepts (cash, gateway, etc.) — do not leave QA-only gateway
  configuration active for a real tenant.
- **WhatsApp** (if this customer wants it): this is currently the one
  setup step that is architecturally ready but operationally new — no
  real customer WhatsApp number has ever been connected in production
  yet (see the WhatsApp section of `MAL3ABY_FINAL_SELL_READINESS.md`).
  Treat this customer's WhatsApp connection as the first real one: pair
  it carefully, watch the connection status transition away from
  `qr_required`, and send one real test notification before relying on
  it operationally.

## GO-LIVE

Complete every gate in `TENANT_GO_LIVE_CHECKLIST.md` (all 19 items) before
telling the customer "you're live." Do not skip gates under time
pressure — this is the project's own standing discipline, not a new rule
introduced here.

## DAY 1

- Confirm the customer's first real booking/transaction went through
  correctly end-to-end (booking → payment → invoice → shows correctly in
  their reports).
- Confirm no error reports came in from the customer's staff.
- Spot-check tenant isolation once more from the Platform Owner view —
  this tenant's data should not appear in any other tenant's screens.

## DAY 3

- Check in with the customer directly: any confusion, any staff member
  who couldn't do something they needed to.
- Confirm notification delivery (booking confirmations, payment receipts)
  is reaching the customer's real inbox/WhatsApp, not landing in spam or
  going undelivered.

## DAY 7

- Review the customer's first week of real usage: booking volume,
  payment volume, any support requests raised.
- Confirm the trial clock is counting down correctly and the customer
  understands how many days remain (this is currently NOT surfaced via
  any lifecycle reminder notification — see the Notifications gap in
  `MAL3ABY_FINAL_SELL_READINESS.md` — so today this must be a manual
  check-in, not something the product reminds them of automatically).

## TRIAL END

- Before the trial's last day, manually confirm with the customer
  whether they intend to convert to paid. There is currently no
  automated "trial ending soon" notification (open gap, noted above) —
  this is a manual follow-up responsibility until that gap is closed.
- If they intend to convert, proceed to CONVERSION TO PAID below. If
  they do not, the product's own trial-expiry handling
  (`get_club_platform_access()` returning a blocked/expired state)
  takes over without further action from you.

## CONVERSION TO PAID

- Use the existing subscription management screen (Platform Owner side)
  to set the customer's real paid plan tier (Starter/Growth/Pro) per the
  commercial terms agreed with them.
- If this customer is one of the first 5 real paying customers and you
  intend to honor the founding offer (50% off for 3 months), be aware
  `claim_founding_customer_slot()` currently has no frontend entry point
  anywhere in the product — it must be invoked directly via RPC/SQL by
  someone with database access, not through a screen the Platform Owner
  can click. This is a known, open gap (see the Open Issue Register in
  `MAL3ABY_FINAL_SELL_READINESS.md`) — plan for it rather than assuming a
  button exists.
- Confirm the customer's plan-appropriate limits (branches, fields,
  academy programs, staff, active players) match what was agreed before
  telling them the conversion is complete.
- Record the conversion in whatever operator tracker is in use, per
  `TENANT_GO_LIVE_CHECKLIST.md`'s own recording gate.

## What this runbook deliberately does not cover

- Bulk/automated tenant provisioning — out of scope by design; this
  remains a manual, one-at-a-time procedure during the controlled
  launch phase.
- Migrating a customer's historical data from another system —
  **no import tooling for customers, players, or facility data exists
  anywhere in this repository today** (confirmed by search: no
  import/CSV/bulk-import RPC or migration exists). If a prospect asks
  for this, treat it as a new, unplanned scope discussion — do not
  promise it as an existing capability. See `MAL3ABY_SALES_CLAIMS_MATRIX.md`.
