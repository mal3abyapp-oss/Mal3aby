# Mal3aby — Backup & Recovery Runbook

**Status as of this writing:** Supabase organization `bmqsldayximwywutofgi` (project `gxkrtlvpjwxhcqdisyob`) is on the **`free`** plan, confirmed live via `get_organization`. **The free tier has no automated backups of any kind** — no daily backups, no Point-in-Time Recovery (PITR). This is a genuine external blocker requiring a paid Supabase plan (Pro tier minimum, $25/mo, for daily backups + 7-day PITR) — a billing decision this task is explicitly not authorized to make unprompted. Everything in this runbook that does NOT require purchasing a plan has been completed; the plan upgrade itself is `PENDING EXTERNAL INPUT`.

---

## 1. If the database is damaged tomorrow, how do we recover?

**Today (free tier, no upgrade yet): we cannot.** There is no backup to restore from. A dropped table, a bad migration, or a Supabase-side incident would mean **total, permanent data loss** for every club's bookings, payments, invoices, and customer records. This is the single most severe operational risk on the entire platform and must be closed before any real paying club's data goes on it.

**After upgrading to Supabase Pro (minimum required action):**
- Daily automated backups, retained 7 days (Pro tier default).
- Point-in-Time Recovery (PITR) available as an add-on — recommended given this is a financial system (see RPO below).
- Restore is performed via the Supabase Dashboard (Database → Backups → Restore) or via `supabase db dump`/`pg_restore` against a new project for a manual export-based recovery.

## 2. Recommended plan tier for this product

**Supabase Pro ($25/mo base) is the minimum floor for a paid pilot club.** Team-tier PITR (finer RPO than daily) is a Phase B (first-30-days) upgrade, not a launch blocker — daily backups + 7-day retention is an acceptable starting RPO/RTO for a single-club pilot (see targets below), and can be tightened once real transaction volume justifies it.

## 3. RPO / RTO Targets (Pilot Phase)

These are realistic, defensible targets for a single-club pilot — not aspirational numbers:

- **RPO (Recovery Point Objective): 24 hours.** With Supabase Pro's daily backup (no PITR add-on yet), worst case is losing up to one day of bookings/payments/messages if an incident happens right before the next daily backup. For a single-pilot-club launch this is an acceptable, explicitly-communicated risk — NOT silently accepted. If the pilot club records more than a handful of transactions per day, upgrade to PITR (RPO measured in minutes) before onboarding a second paying club.
- **RTO (Recovery Time Objective): 4 hours.** Supabase-managed restore from a daily backup is typically completed within an hour by Supabase support/dashboard tooling; the remaining budget covers re-pointing `PUBLIC_APP_URL`/DNS if the restore lands on a new project ref, re-verifying RLS/migrations applied cleanly, and re-establishing the WhatsApp connector's session (see §5).
- These targets MUST be re-stated to the club owner in plain language before they pay: *"in the rare case of a database incident, we may lose up to the last 24 hours of activity and may take up to 4 hours to restore service."* This is a commercial/trust conversation, not just an engineering one.

## 4. Restore Procedure (once Pro tier is active)

1. **Detect the incident** — see `MAL3ABY_PRODUCTION_READINESS.md` Observability section for what alerting exists/is missing; today this is likely a manual report from the club owner or a failed health check (§6 of this doc).
2. **Do not attempt destructive recovery on the live project.** Stop the WhatsApp connector process first (prevents it from writing further queue-claim state against a database that may be restored to an earlier point).
3. Via Supabase Dashboard → Database → Backups: select the most recent (or most appropriate PITR timestamp) and initiate restore. Supabase performs this as a new project or in-place restore depending on plan — follow the dashboard's own current guidance at restore time (this UI has changed across plan tiers historically; don't hard-code exact click-paths in this runbook).
4. Once restored, re-run `list_migrations` (or `supabase db diff` locally) to confirm the restored schema matches what this repo's `supabase/migrations/` expects. **A restore that lands slightly before the most recent migration will need that migration re-applied** — migrations in this repo are idempotent-safe to re-run (`create or replace function`, `create table if not exists`, etc. throughout) except where explicitly marked otherwise.
5. Re-point the frontend's `VITE_SUPABASE_URL`/anon key and the connector's `SUPABASE_URL`/service-role key if the restore produced a new project ref (rare, but the dashboard sometimes does this for certain restore types).
6. Restart the WhatsApp connector (see §5 for session-state implications).
7. Smoke-test: log in as a real staff user, view Today/Bookings, confirm a known real booking/invoice is present and correct, confirm `whatsapp_accounts.status = 'connected'`.
8. Notify the pilot club owner directly, in plain language, of what happened and the RPO window (what may have been lost).

## 5. WhatsApp Auth-State Recovery

**Where sessions are stored:** `whatsapp_accounts.session_credentials_encrypted` (bytea, AES-256-GCM encrypted) — the encrypted Baileys multi-file auth state, persisted in the same Postgres database as everything else. This means:

- **A full database restore (§4) automatically restores the WhatsApp session too** — no separate WhatsApp-specific backup mechanism is needed, since it lives in the same backed-up tables. This is a genuine architectural strength worth confirming explicitly: WhatsApp auth state is NOT stored only on the connector's local disk (`WHATSAPP_TEMP_AUTH_DIR` is explicitly documented as *temporary* working storage, not the source of truth).
- **The encryption key (`WHATSAPP_SESSION_ENCRYPTION_KEY`) is NOT stored in the database** — it lives only in the connector's `.env` file (git-ignored, correctly). **If this key is lost independently of a database incident (e.g. the connector's host disk fails, or the `.env` file is deleted without a copy), the encrypted session in the database becomes permanently undecryptable even though the row itself survived.** This is the one genuine single point of failure in WhatsApp recovery, and it is NOT covered by a Supabase plan upgrade.

**Action required (not a Supabase billing decision — safe to do now):** the `WHATSAPP_SESSION_ENCRYPTION_KEY` value must be copied to a second, independently-backed-up location (a password manager entry, a secrets vault, or at minimum an encrypted note kept outside the connector host) before the pilot's real WhatsApp number connects for production use. **This runbook flags it; it has not been done automatically by this remediation pass because it requires the human operator to choose and access a secure storage location — this is exactly the kind of "external input" (a secrets-management decision) this task defers rather than guesses at.**

If the key is genuinely lost with no independent copy: the only recovery is disconnecting and re-pairing the club's WhatsApp number from scratch (a real, user-visible re-scan of a QR code on the club's phone) — not data loss for bookings/payments/customers, but a one-time WhatsApp reconnection interruption.

## 6. Critical Configuration Backup

Beyond the database itself, these must be preserved independently (not in git, not only on one machine):

- `whatsapp-connector/.env` — `SUPABASE_SERVICE_ROLE_KEY`, `WHATSAPP_SESSION_ENCRYPTION_KEY`, `PUBLIC_APP_URL` (production value, once set).
- Supabase project's own dashboard-level secrets (if any Edge Functions or Vault secrets are added later).
- The production domain's DNS/SSL configuration (once a real domain exists — see deployment runbook).

**Status:** these currently exist in exactly one place (this development machine's local `.env` file). No second copy exists yet. Flagged as a pre-launch action item, not auto-remediated here for the same reason as §5 — it requires the human operator's own secrets-storage choice.

---

## Summary: What Is and Isn't Done

| Item | Status |
|---|---|
| Backup/restore procedure documented | ✅ Done (this file) |
| RPO/RTO defined with honest, defensible numbers | ✅ Done (§3) |
| WhatsApp auth-state recovery analyzed | ✅ Done (§5) — confirmed it rides along with DB backup once that exists |
| Actual automated backups enabled | ❌ **PENDING EXTERNAL INPUT** — requires upgrading Supabase org `bmqsldayximwywutofgi` off the `free` plan (billing decision, $25/mo minimum) |
| Encryption key backed up to a second location | ❌ **PENDING EXTERNAL INPUT** — requires the operator to choose and use a secrets-storage tool |
| `.env` secrets backed up to a second location | ❌ **PENDING EXTERNAL INPUT** — same as above |

**This is the honest state of C6 from `MAL3ABY_PRODUCTION_READINESS.md`: the runbook and the analysis are complete; the actual backup infrastructure requires a real payment decision this task will not make without you.**
