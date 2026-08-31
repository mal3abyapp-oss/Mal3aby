# First Customer Onboarding Runbook

Written 2026-08-31, Controlled Commercial Launch Gate, Phase 7.

Exact operator procedure for onboarding the first (and every subsequent)
real, paying tenant. **No direct SQL required for normal onboarding** —
every step below uses the existing product UI/RPC surface, already
proven correct across the Full Product E2E acceptance.

## Before you start

- [ ] A fresh backup exists and is verified (`python3
      backups/verify_manifest.py backups/<latest>` → `ALL CHECKS
      PASSED`). See [BACKUP_RUNBOOK.md](BACKUP_RUNBOOK.md).
- [ ] You have the tenant's real business name, owner contact email,
      preferred branch name(s), and confirmed subscription tier.
- [ ] You are logged in as Platform Owner on `https://mal3aby.app`.

## Procedure

1. **Verify production identity.** Confirm the browser console shows
   `[Mal3aby] build <sha>` matching the current deployed commit (see
   [PRODUCTION_OPERATIONS_DR_ACCEPTANCE.md](PRODUCTION_OPERATIONS_DR_ACCEPTANCE.md)
   for how to check). Never onboard a real customer against a build
   you haven't identified.
2. **Create the tenant (club)** via the Platform Owner "Create Club"
   flow — enter the real business name exactly as the customer wants
   it displayed (this appears on customer-facing invoices/receipts).
3. **Set the subscription tier** for the new tenant per the agreed
   commercial terms (trial/paid, plan level) using the existing
   subscription management screen.
4. **Confirm tenant status is `active`** (not `suspended`,
   `pending`, or any QA-only status) before proceeding.
5. **Create the branch(es)** the customer actually operates, with
   real names/addresses — not placeholder data.
6. **Set branch-level configuration**: currency (confirm EGP or the
   customer's actual currency), timezone, and operating hours.
7. **Create the Owner-role staff account** for the customer's actual
   business owner/manager using their real email address. Use the
   platform's staff-invitation flow — never a shared/generic email.
8. **Have the customer's owner complete their own first login** via
   the invitation email, setting their own password. Confirm via the
   product (not by asking them to screenshot) that their account
   shows `active`, not `invited`.
9. **Create any additional real staff accounts** the customer needs
   (front desk, coach, etc.), one real person per account — never a
   shared login.
10. **Create real courts/fields or academy groups** matching the
    customer's actual physical setup and pricing.
11. **Set real pricing** (hourly rates, membership prices, academy
    fees) per the customer's actual agreed rates — never leave QA
    placeholder pricing (e.g. 1 EGP/hour) live for a real tenant.
12. **Configure the customer-facing public booking page** (if the
    tenant's plan includes it) and verify it loads correctly and
    shows only that tenant's real courts/pricing.
13. **Send the customer a test notification** (e.g. trigger a
    booking-confirmation email to a real address you control) to
    confirm the email pipeline reaches their domain without landing
    in spam, before relying on it for real customer communication.
14. **Walk through one real (non-QA) booking end-to-end** with the
    customer or on their behalf: create booking → confirm → take
    payment → verify invoice → verify it appears in their reports.
    This IS the "first real transaction" — see
    [TENANT_GO_LIVE_CHECKLIST.md](TENANT_GO_LIVE_CHECKLIST.md) Phase 9
    for the enhanced review procedure to apply to it.
15. **Verify tenant isolation** by confirming, from the Platform
    Owner view, that this tenant's data does not appear when viewing
    any other tenant's screens (spot check, not a full attack replay
    — that was already exhaustively proven in Full Product E2E).
16. **Enable ongoing notifications** the tenant needs (booking
    confirmations, payment receipts, etc.) per their preferences.
17. **Brief the customer** on how to reach support (see
    [INCIDENT_RUNBOOKS.md](INCIDENT_RUNBOOKS.md) for the operator
    side) and set expectations for response time during the pilot.
18. **Record the onboarding** in whatever operator log/tracker is in
    use (tenant name, date, staff who onboarded them, subscription
    tier) — this is what
    [TENANT_GO_LIVE_CHECKLIST.md](TENANT_GO_LIVE_CHECKLIST.md) is for.
19. **Complete the Tenant Go-Live Checklist** in full before telling
    the customer "you're live" — do not skip gates under time
    pressure.
20. **Schedule a follow-up check** (next business day) to confirm the
    customer's first real day of usage went smoothly — this feeds
    into [Pilot Health Check](#) monitoring (see the launch report's
    Phase 11 section).

## What this runbook deliberately does NOT cover

- Bulk/automated tenant provisioning — out of scope; this is a
  manual, careful, one-at-a-time procedure by design during the
  controlled pilot (see Phase 10 of the launch report).
- Migrating a customer's historical data from another system — not
  a supported feature today; if requested, treat as a new (unplanned)
  scope discussion, not something to improvise via direct SQL.
