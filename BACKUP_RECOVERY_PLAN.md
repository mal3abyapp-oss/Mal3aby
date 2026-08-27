# Backup & Recovery Plan

## Current factual state (verified directly, not assumed)

- **Organization plan**: `free` — confirmed via `get_organization`
  against the real production organization
  (`bmqsldayximwywutofgi`, "mal3abyapp-oss's Org").
- **Project**: `gxkrtlvpjwxhcqdisyob` ("mal3abyapp-oss's Project"),
  region `eu-central-1`, Postgres 17.6, status `ACTIVE_HEALTHY`.

## What backup capability actually exists today

**None.** Supabase's Free tier does **not** include automatic daily
backups or Point-in-Time Recovery (PITR) — both are Pro-tier-and-above
features. This was verified against Supabase's own current
documentation, not assumed from general platform knowledge:

- Daily automated backups: Pro plan and above only (Pro: 7-day
  rolling retention, Team: 14 days, Enterprise: up to 30 days).
- PITR (up-to-the-second recovery): an additional paid add-on on top
  of a paid plan, roughly $100/month.
- **On Free, Supabase's own guidance is that the project owner must
  run manual `supabase db dump` exports and store them off-platform
  themselves** — there is no platform-provided recovery path at all.

Source: [Supabase Database Backups docs](https://supabase.com/docs/guides/platform/backups), [Supabase Pricing 2026 overview](https://www.metacto.com/blogs/the-true-cost-of-supabase-a-comprehensive-guide-to-pricing-integration-and-maintenance).

## What this means in concrete terms

If the production database were lost, corrupted, or a bad migration
caused unrecoverable data loss, **there is currently no built-in path
to restore it** — not "restore to an older snapshot," not "roll back
to yesterday," nothing. Every booking, invoice, payment, customer
record, and audit-log entry created since this project began would be
permanently gone.

This is a genuine, serious gap for a platform that will hold real
clubs' financial records. It is not something this session can
silently work around or declare acceptable on the user's behalf.

## Why this is not fixed in this session

Getting real backup/PITR capability requires **upgrading the Supabase
organization to a paid plan** (Pro at minimum, $25/mo, for 7-day daily
backups; PITR is a further paid add-on for sub-daily recovery points).
This is exactly the directive's own **Stop Condition #2**: "a
genuinely necessary NEW paid external infrastructure service is
required." Purchasing that upgrade is the user's decision to make, not
something this session will do unilaterally.

**This is flagged as a TRUE STOP CONDITION, not silently worked
around, and not declared launch-ready while it stands unresolved.**

## Recommended action

1. **Upgrade the Supabase organization to the Pro plan** ($25/mo
   minimum) before accepting real customer data in production. This
   alone restores 7-day rolling daily backups.
2. **Consider adding PITR** (~$100/mo add-on) once real transaction
   volume justifies sub-daily recovery granularity — not strictly
   required to clear the BLOCKER, but meaningfully reduces the
   worst-case data-loss window from "up to 24 hours" to "seconds."
3. **Until an upgrade happens**, the only mitigation available today is
   a manual, human-run `supabase db dump --project-ref gxkrtlvpjwxhcqdisyob`
   export on some regular cadence, stored somewhere off-platform (a
   private repo, cloud storage bucket, etc.). This is NOT equivalent to
   real backups — it requires a human to remember to run it, has no
   automatic retention/rotation, and cannot restore point-in-time; it
   is documented here only as the least-bad interim option while a
   plan-upgrade decision is pending.

## RTO / RPO (honest, given current state)

- **RTO (Recovery Time Objective)**: undefined / not achievable today
  — there is no automated restore path.
- **RPO (Recovery Point Objective)**: undefined / not achievable today
  — with no backups, the RPO is effectively "everything since project
  creation," not a bounded window.
- **After a Pro-plan upgrade**: RPO improves to ≤24 hours (daily
  backup) or seconds (with PITR add-on); RTO becomes whatever Supabase's
  own restore-from-backup process takes (Supabase does not publish a
  fixed RTO figure; this should be re-confirmed against their current
  docs at upgrade time rather than assumed here).

## Responsibility

- **Plan upgrade decision**: the user (business/financial decision,
  real recurring cost).
- **Manual interim export cadence** (if the upgrade is delayed): the
  user or whoever they designate — this session cannot run a
  recurring human task.
- **Verifying backups actually work once enabled**: should be a
  concrete post-upgrade task (Supabase's restore process should be
  test-run against a branch/staging project, never first attempted
  during a real incident).
