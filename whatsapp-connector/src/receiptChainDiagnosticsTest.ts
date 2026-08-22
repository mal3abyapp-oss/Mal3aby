/**
 * receiptChainDiagnosticsTest.ts -- ROOT-CAUSE INVESTIGATION fix
 * (2026-08-22), regression coverage for recordRawMessagesUpdateEvent()
 * (ReceiptChainDiagnostics.ts): the raw, pre-filter messages.update
 * event recorder that distinguishes "the listener never receives any
 * server-originated receipt traffic at all" from "events arrive but
 * get filtered out by extractDeliveryReceipts()'s own logic".
 *
 * Run with: npx tsx src/receiptChainDiagnosticsTest.ts
 */
import assert from 'node:assert/strict'
import { recordRawMessagesUpdateEvent, getReceiptChainDiagnosticsSnapshot } from './ReceiptChainDiagnostics.js'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`[receiptChainDiagnosticsTest] PASS - ${name}`)
  } catch (err) {
    failures += 1
    console.error(`[receiptChainDiagnosticsTest] FAIL - ${name}`)
    console.error(`  ${(err as Error).message}`)
  }
}

check('a genuine fromMe receipt with a real key.id and status is recorded with all fields correct', () => {
  const before = getReceiptChainDiagnosticsSnapshot()
  recordRawMessagesUpdateEvent([{ key: { fromMe: true, id: 'MSG1' }, update: { status: 3 } }])
  const after = getReceiptChainDiagnosticsSnapshot()
  assert.equal(after.totalMessagesUpdateEventsFired, before.totalMessagesUpdateEventsFired + 1)
  assert.equal(after.totalIndividualUpdatesRecorded, before.totalIndividualUpdatesRecorded + 1)
  const entry = after.recent.at(-1)
  assert.equal(entry?.fromMe, true)
  assert.equal(entry?.hasKeyId, true)
  assert.equal(entry?.statusLevel, 3)
})

check('an event array increments totalMessagesUpdateEventsFired ONCE regardless of how many individual updates it contains', () => {
  const before = getReceiptChainDiagnosticsSnapshot()
  recordRawMessagesUpdateEvent([
    { key: { fromMe: true, id: 'A' }, update: { status: 2 } },
    { key: { fromMe: false, id: 'B' }, update: { status: 4 } },
  ])
  const after = getReceiptChainDiagnosticsSnapshot()
  assert.equal(after.totalMessagesUpdateEventsFired, before.totalMessagesUpdateEventsFired + 1)
  assert.equal(after.totalIndividualUpdatesRecorded, before.totalIndividualUpdatesRecorded + 2)
})

check('an empty event array still increments totalMessagesUpdateEventsFired (the listener DID fire), but records zero individual updates', () => {
  const before = getReceiptChainDiagnosticsSnapshot()
  recordRawMessagesUpdateEvent([])
  const after = getReceiptChainDiagnosticsSnapshot()
  assert.equal(after.totalMessagesUpdateEventsFired, before.totalMessagesUpdateEventsFired + 1)
  assert.equal(after.totalIndividualUpdatesRecorded, before.totalIndividualUpdatesRecorded)
})

check('missing key.id is recorded as hasKeyId:false, not omitted', () => {
  recordRawMessagesUpdateEvent([{ key: { fromMe: true, id: null }, update: {} }])
  const entry = getReceiptChainDiagnosticsSnapshot().recent.at(-1)
  assert.equal(entry?.hasKeyId, false)
  assert.equal(entry?.statusLevel, null)
})

check('an update with extra fields beyond status/messageTimestamp sets hasOtherUpdateFields:true', () => {
  recordRawMessagesUpdateEvent([{ key: { fromMe: true, id: 'X' }, update: { status: 1, someOtherField: 'x' } }])
  const entry = getReceiptChainDiagnosticsSnapshot().recent.at(-1)
  assert.equal(entry?.hasOtherUpdateFields, true)
})

check('an update with only status/messageTimestamp sets hasOtherUpdateFields:false', () => {
  recordRawMessagesUpdateEvent([{ key: { fromMe: true, id: 'Y' }, update: { status: 1, messageTimestamp: 123 } }])
  const entry = getReceiptChainDiagnosticsSnapshot().recent.at(-1)
  assert.equal(entry?.hasOtherUpdateFields, false)
})

check('undefined fromMe (not a boolean) is recorded as null, never crashes', () => {
  recordRawMessagesUpdateEvent([{ key: { id: 'Z' }, update: {} }])
  const entry = getReceiptChainDiagnosticsSnapshot().recent.at(-1)
  assert.equal(entry?.fromMe, null)
})

console.log(`\n[receiptChainDiagnosticsTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
if (failures > 0) process.exit(1)
