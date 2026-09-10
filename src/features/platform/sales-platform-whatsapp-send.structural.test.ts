import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// OWNER DECISION #20 REGRESSION TESTS -- STRUCTURAL PROOF LAYER.
//
// Guards the enabled Sales -> Platform WhatsApp send pipeline:
//   supabase/migrations/20260910110000_sales_whatsapp_message_channel_and_edit_tracking.sql
//     -- new channel='whatsapp_message' + edited_body/edited_at/edited_by
//        tracking on sales_outreach_messages.
//   supabase/migrations/20260910120000_sales_platform_whatsapp_send_enabled.sql
//     -- sales_queue_platform_whatsapp_message() re-defined (CREATE OR
//        REPLACE) to ACTUALLY queue an approved whatsapp_message draft,
//        superseding the deliberately-disabled version from
//        20260909200000_platform_whatsapp_domain.sql. This file is the
//        one that reflects what is actually deployed today -- a
//        `create or replace function` with the same name/signature
//        always wins as "the current definition" regardless of which
//        migration file it lives in, since migrations apply in
//        chronological (filename) order and 20260910120000 sorts after
//        20260909200000.
//
// Proof style: this suite reads the REAL migration SQL files directly
// (this project's own source of truth for what's deployed) and asserts
// on the parsed text, exactly the technique
// platform-whatsapp-domain-isolation.integration.test.ts's own
// structural block already uses. These assertions require no live DB
// access and always run, in every environment.
//
// Decision #20's explicit test list (see also the sibling live-
// integration file, sales-platform-whatsapp-send.integration.test.ts):
//   1. AI cannot send automatically                          -- covered below
//   4. Owner-edited approved draft sends the edited version   -- covered below
//   5. Send uses Platform WhatsApp only / no tenant session   -- covered below
//   6. Duplicate Send/retry does not duplicate delivery       -- covered below
//      (unique constraint + explicit guard, both structural)
//   8. Disconnected Platform WhatsApp -- connection-state check finding -- covered below
//   9. Audit trail records the operation                      -- covered below
// Items 2/3/7/10/11 are live-integration or gated-fixture and live in
// the sibling *.integration.test.ts file.

const CHANNEL_MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260910110000_sales_whatsapp_message_channel_and_edit_tracking.sql',
)
const SEND_MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260910120000_sales_platform_whatsapp_send_enabled.sql',
)
const OUTREACH_LIFECYCLE_MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260904090400_sales_intelligence_scoring_outreach_conversion.sql',
)

const channelSql = fs.readFileSync(CHANNEL_MIGRATION_PATH, 'utf8')
const sendSql = fs.readFileSync(SEND_MIGRATION_PATH, 'utf8')
const lifecycleSql = fs.readFileSync(OUTREACH_LIFECYCLE_MIGRATION_PATH, 'utf8')

function extractFunctionBody(sql: string, functionSignature: string): string {
  const startIdx = sql.indexOf(functionSignature)
  if (startIdx === -1) {
    throw new Error(`function signature not found in migration: ${functionSignature}`)
  }
  const bodyStart = sql.indexOf('as $$', startIdx)
  const bodyEnd = sql.indexOf('$$;', bodyStart)
  if (bodyStart === -1 || bodyEnd === -1) {
    throw new Error(`could not isolate $$ body for: ${functionSignature}`)
  }
  return sql.slice(bodyStart, bodyEnd + 3)
}

describe('Owner decision #20 -- Sales -> Platform WhatsApp send, STRUCTURAL proof (parses the real migration SQL, no live DB required)', () => {
  // -------------------------------------------------------------
  // Item 1: AI cannot send automatically.
  // -------------------------------------------------------------
  it('sales_generate_outreach_message() never transitions status past \'generated\' -- no reference to platform_whatsapp_queue or sales_queue_platform_whatsapp_message anywhere in its body', () => {
    const body = extractFunctionBody(
      lifecycleSql,
      'create or replace function public.sales_generate_outreach_message(',
    )
    expect(body).not.toContain('platform_whatsapp_queue')
    expect(body).not.toContain('sales_queue_platform_whatsapp_message')
    expect(body).not.toMatch(/status\s*=\s*'approved'/)
    expect(body).not.toMatch(/status\s*=\s*'queued'/)
    expect(body).not.toMatch(/status\s*=\s*'sent'/)
    // The only status this function ever writes is the implicit default
    // ('generated') on INSERT -- confirmed by there being no UPDATE
    // ... set status statement in the body at all.
    expect(body).not.toMatch(/update\s+public\.sales_outreach_messages\s+set\s+status/)
  })

  it('sales_approve_outreach_message() only ever sets status=\'approved\' -- never itself enqueues or sends (no INSERT into platform_whatsapp_queue, no call to sales_queue_platform_whatsapp_message)', () => {
    const body = extractFunctionBody(
      lifecycleSql,
      'create or replace function public.sales_approve_outreach_message(p_message_id uuid)',
    )
    expect(body).toMatch(/set\s+status\s*=\s*'approved'/)
    expect(body).not.toContain('platform_whatsapp_queue')
    expect(body).not.toContain('sales_queue_platform_whatsapp_message')
    expect(body).not.toMatch(/insert into public\.platform_whatsapp_queue/)
    // Only ever transitions FROM 'generated' -- cannot re-approve an
    // already-approved/queued/sent/rejected message either.
    expect(body).toMatch(/where\s+id\s*=\s*p_message_id\s+and\s+status\s*=\s*'generated'/)
  })

  // -------------------------------------------------------------
  // Item 4: owner-edited approved draft sends the EDITED version.
  // -------------------------------------------------------------
  it('sales_queue_platform_whatsapp_message()\'s effective send body is coalesce(edited_body, body, ...) -- never body alone', () => {
    const body = extractFunctionBody(
      sendSql,
      'create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)',
    )
    expect(body).toMatch(/coalesce\(v_message\.edited_body,\s*v_message\.body/)
    // The insert into platform_whatsapp_queue.message_body must use the
    // coalesced variable, not v_message.body directly.
    const insertIdx = body.indexOf('insert into public.platform_whatsapp_queue')
    expect(insertIdx).toBeGreaterThan(-1)
    const insertStatement = body.slice(insertIdx, body.indexOf(';', insertIdx) + 1)
    expect(insertStatement).toContain('v_effective_body')
    expect(insertStatement).not.toContain('v_message.body')
  })

  it('the edit-tracking migration confirms edited_body is additive and body is never overwritten -- the coalesce is a structural guarantee, not a UI convention', () => {
    expect(channelSql).toMatch(/add column if not exists edited_body text/)
    expect(channelSql).toMatch(/add column if not exists edited_at timestamptz/)
    expect(channelSql).toMatch(/add column if not exists edited_by uuid references auth\.users\(id\)/)
    expect(channelSql).toContain('body itself is NEVER modified after generation')
    expect(channelSql).toContain('coalesce(edited_body, body)')
  })

  it('whatsapp_message is a genuinely new, structurally distinct channel value -- whatsapp_talking_points remains permanently un-sendable through this function', () => {
    expect(channelSql).toMatch(
      /check \(channel in \('email', 'phone_script', 'whatsapp_talking_points', 'whatsapp_message'\)\)/,
    )
    const body = extractFunctionBody(
      sendSql,
      'create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)',
    )
    expect(body).toMatch(/if v_message\.channel <> 'whatsapp_message' then/)
    expect(body).toContain('whatsapp_talking_points is a human call/chat script')
  })

  // -------------------------------------------------------------
  // Item 5: Platform WhatsApp only, no tenant session reachable.
  // -------------------------------------------------------------
  it('sales_queue_platform_whatsapp_message() has NO p_club_id parameter anywhere in its signature, and its only INSERT target is platform_whatsapp_queue', () => {
    const sigMatch = sendSql.match(
      /create or replace function public\.sales_queue_platform_whatsapp_message\(([^)]*)\)/,
    )
    expect(sigMatch).toBeTruthy()
    const paramList = sigMatch![1]!
    expect(paramList).not.toMatch(/\bclub_id\b/i)
    expect(paramList.trim()).toBe('p_message_id uuid')

    const body = extractFunctionBody(
      sendSql,
      'create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)',
    )
    const insertTargets = [...body.matchAll(/insert into public\.(\w+)/g)].map((m) => m[1])
    expect(insertTargets).toContain('platform_whatsapp_queue')
    // Every INSERT target must be an allowlisted table -- the send queue
    // itself, plus the pre-existing sales activity timeline (audit-ish,
    // not a delivery channel).
    const allowedInsertTargets = new Set(['platform_whatsapp_queue', 'sales_lead_activities'])
    for (const target of insertTargets) {
      expect(allowedInsertTargets.has(target!)).toBe(true)
    }
  })

  it('sales_queue_platform_whatsapp_message() body never references notification_queue or whatsapp_accounts (the tenant-session tables)', () => {
    const body = extractFunctionBody(
      sendSql,
      'create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)',
    )
    expect(body).not.toContain('notification_queue')
    expect(body).not.toMatch(/\bwhatsapp_accounts\b/)
    // "whatsapp_platform_account" style substring guard -- explicit
    // exact-name check so a reversed/partial match can't hide a real
    // reference to the tenant table.
    expect(body).not.toMatch(/from public\.whatsapp_accounts\b/)
    expect(body).not.toMatch(/join public\.whatsapp_accounts\b/)
  })

  // -------------------------------------------------------------
  // Item 6: duplicate Send/retry does not duplicate delivery.
  // -------------------------------------------------------------
  it('platform_whatsapp_queue_outreach_message_id_unique constraint exists in the migration -- one queue row per outreach message, ever (structural, no live DB query available in this repo\'s test convention)', () => {
    expect(sendSql).toMatch(
      /alter table public\.platform_whatsapp_queue\s+add constraint platform_whatsapp_queue_outreach_message_id_unique unique \(outreach_message_id\)/,
    )
  })

  it('sales_queue_platform_whatsapp_message() has an explicit "already queued" guard BEFORE its INSERT, independent of relying on the unique-constraint violation alone', () => {
    const body = extractFunctionBody(
      sendSql,
      'create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)',
    )
    const guardIdx = body.indexOf('already been queued or sent')
    const insertIdx = body.indexOf('insert into public.platform_whatsapp_queue')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(insertIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(insertIdx)
    expect(body).toMatch(
      /if exists \(select 1 from public\.platform_whatsapp_queue where outreach_message_id = p_message_id\) then/,
    )
  })

  // -------------------------------------------------------------
  // Item 8: disconnected Platform WhatsApp blocks sending safely.
  //
  // NOTE ON TIMING: as first read for this test pass, the deployed
  // sales_queue_platform_whatsapp_message() had NO connection-status
  // check at all -- it would queue a row unconditionally, leaving it
  // stuck in platform_whatsapp_queue forever if the platform account
  // were disconnected (only whatsapp_connector_claim_next_platform_batch(),
  // a separate function, refused to CLAIM anything while disconnected).
  // That was flagged as a real correctness gap. Before this suite could
  // be finalized, the migration file was updated (still within this same
  // 20260910120000_sales_platform_whatsapp_send_enabled.sql file, same
  // function) to add an explicit guard: `if not exists (select 1 from
  // platform_whatsapp_account where status = 'connected') then raise
  // exception 'platform_whatsapp_not_connected: ...'`. This test now
  // asserts that the guard is genuinely present and runs BEFORE the
  // queue INSERT -- confirming the gap is closed, not assuming it either
  // way.
  // -------------------------------------------------------------
  it('sales_queue_platform_whatsapp_message() DOES check platform_whatsapp_account.status = \'connected\' before inserting into the queue, and raises a distinct, frontend-recognizable exception when disconnected -- confirmed present, and running BEFORE the INSERT', () => {
    const body = extractFunctionBody(
      sendSql,
      'create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)',
    )
    expect(body).toMatch(
      /if not exists \(select 1 from public\.platform_whatsapp_account where status = 'connected'\) then/,
    )
    expect(body).toContain('platform_whatsapp_not_connected:')

    const guardIdx = body.indexOf("if not exists (select 1 from public.platform_whatsapp_account where status = 'connected')")
    const insertIdx = body.indexOf('insert into public.platform_whatsapp_queue')
    expect(guardIdx).toBeGreaterThan(-1)
    expect(insertIdx).toBeGreaterThan(-1)
    expect(guardIdx).toBeLessThan(insertIdx)
  })

  it('the connection-status guard also runs AFTER the status/channel/duplicate guards -- so a caller gets the most specific applicable error (approved-status / already-queued take precedence over connection state, matching the guard ordering documented in the migration)', () => {
    const body = extractFunctionBody(
      sendSql,
      'create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)',
    )
    const statusGuardIdx = body.indexOf("if v_message.status <> 'approved' then")
    const duplicateGuardIdx = body.indexOf('already been queued or sent')
    const connectionGuardIdx = body.indexOf("if not exists (select 1 from public.platform_whatsapp_account where status = 'connected')")
    expect(statusGuardIdx).toBeGreaterThan(-1)
    expect(duplicateGuardIdx).toBeGreaterThan(-1)
    expect(connectionGuardIdx).toBeGreaterThan(-1)
    expect(statusGuardIdx).toBeLessThan(connectionGuardIdx)
    expect(duplicateGuardIdx).toBeLessThan(connectionGuardIdx)
  })

  // -------------------------------------------------------------
  // Item 9: audit trail records the operation.
  // -------------------------------------------------------------
  it('sales_queue_platform_whatsapp_message() calls write_audit_log', () => {
    const body = extractFunctionBody(
      sendSql,
      'create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)',
    )
    expect(body).toMatch(/perform public\.write_audit_log\(/)
    expect(body).toContain("'sales.platform_whatsapp_message_queued'")
  })

  // -------------------------------------------------------------
  // Item 7 (structural half): send authority moved to the WhatsApp-
  // specific permission, textually distinct from the old generic one.
  // The live-integration half (a real staff session proving both
  // permissions independently) lives in the sibling *.integration.test.ts.
  // -------------------------------------------------------------
  it('sales_queue_platform_whatsapp_message() authorizes on platform.whatsapp_platform.manage, never platform.sales.send_outreach', () => {
    const body = extractFunctionBody(
      sendSql,
      'create or replace function public.sales_queue_platform_whatsapp_message(p_message_id uuid)',
    )
    expect(body).toContain("has_platform_permission('platform.whatsapp_platform.manage')")
    expect(body).not.toContain("has_platform_permission('platform.sales.send_outreach')")
  })

  it('the pre-existing email queue path (sales_queue_outreach_message) still authorizes on platform.sales.send_outreach -- confirming the permission MOVED for WhatsApp specifically, rather than being removed everywhere', () => {
    const body = extractFunctionBody(
      lifecycleSql,
      'create or replace function public.sales_queue_outreach_message(p_message_id uuid)',
    )
    expect(body).toContain("has_platform_permission('platform.sales.send_outreach')")
  })
})
