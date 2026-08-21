/**
 * deliveryReceiptExtractionTest.ts -- WHATSAPP DELIVERY TRUTH fix
 * (2026-08-22), regression coverage for the real production defect
 * where notification_queue.status was set to 'sent' the instant
 * BaileysProvider.sendMessage()'s Promise resolved -- which only ever
 * proved this connector wrote bytes to its own outbound socket
 * (confirmed by reading @whiskeysockets/baileys's own socket.js/
 * messages-send.js directly: sendNode -> sendRawMessage is a raw
 * WebSocket write with no server acknowledgment, and the returned
 * message id is purely client-generated). Real evidence of server
 * acceptance/delivery/read exists via a genuine messages.update event
 * carrying proto.WebMessageInfo.Status, correlated by the same
 * client-generated key already stored as provider_reference -- this
 * file tests the pure extraction/filtering logic
 * (extractDeliveryReceipts, BaileysProvider.ts) that turns a raw
 * Baileys event array into the (messageKeyId, statusLevel) pairs
 * actually reported to the database.
 *
 * Run with: npx tsx src/deliveryReceiptExtractionTest.ts
 */
import assert from 'node:assert/strict'
import { extractDeliveryReceipts } from './BaileysProvider.js'

let failures = 0
function check(name: string, fn: () => void) {
  try {
    fn()
    console.log(`[deliveryReceiptExtractionTest] PASS - ${name}`)
  } catch (err) {
    failures += 1
    console.error(`[deliveryReceiptExtractionTest] FAIL - ${name}`)
    console.error(`  ${(err as Error).message}`)
  }
}

// proto.WebMessageInfo.Status real values, confirmed live from the
// installed @whiskeysockets/baileys package:
const ERROR = 0
const PENDING = 1
const SERVER_ACK = 2
const DELIVERY_ACK = 3
const READ = 4
const PLAYED = 5

check('a genuine fromMe receipt with a real key.id and status is extracted', () => {
  const result = extractDeliveryReceipts([{ key: { fromMe: true, id: 'MSG123' }, update: { status: DELIVERY_ACK } }])
  assert.deepEqual(result, [{ messageKeyId: 'MSG123', statusLevel: DELIVERY_ACK }])
})

check('a receipt for an INCOMING message (fromMe: false) is ignored -- this connector only tracks its own sent messages', () => {
  const result = extractDeliveryReceipts([{ key: { fromMe: false, id: 'MSG456' }, update: { status: READ } }])
  assert.equal(result.length, 0)
})

check('an update with no key.id is ignored -- no correlation key means nothing to report', () => {
  const result = extractDeliveryReceipts([{ key: { fromMe: true, id: null }, update: { status: DELIVERY_ACK } }])
  assert.equal(result.length, 0)
})

check('an update with undefined status is ignored -- not every messages.update carries a status change', () => {
  const result = extractDeliveryReceipts([{ key: { fromMe: true, id: 'MSG789' }, update: {} }])
  assert.equal(result.length, 0)
})

check('an update with status explicitly null is ignored, same as undefined', () => {
  const result = extractDeliveryReceipts([{ key: { fromMe: true, id: 'MSG789' }, update: { status: null } }])
  assert.equal(result.length, 0)
})

check('ERROR(0) and PENDING(1) status levels are still extracted -- filtering by ack level is the DB RPC\'s job, not this layer\'s', () => {
  const result = extractDeliveryReceipts([
    { key: { fromMe: true, id: 'MSG-err' }, update: { status: ERROR } },
    { key: { fromMe: true, id: 'MSG-pending' }, update: { status: PENDING } },
  ])
  assert.deepEqual(result, [
    { messageKeyId: 'MSG-err', statusLevel: ERROR },
    { messageKeyId: 'MSG-pending', statusLevel: PENDING },
  ])
})

check('a batch of mixed valid/invalid updates only extracts the valid ones, preserving order', () => {
  const result = extractDeliveryReceipts([
    { key: { fromMe: true, id: 'A' }, update: { status: SERVER_ACK } },
    { key: { fromMe: false, id: 'B' }, update: { status: READ } }, // incoming, dropped
    { key: { fromMe: true, id: null }, update: { status: DELIVERY_ACK } }, // no id, dropped
    { key: { fromMe: true, id: 'D' }, update: {} }, // no status, dropped
    { key: { fromMe: true, id: 'E' }, update: { status: PLAYED } },
  ])
  assert.deepEqual(result, [
    { messageKeyId: 'A', statusLevel: SERVER_ACK },
    { messageKeyId: 'E', statusLevel: PLAYED },
  ])
})

check('an empty update array produces an empty result, never throws', () => {
  const result = extractDeliveryReceipts([])
  assert.deepEqual(result, [])
})

console.log(`\n[deliveryReceiptExtractionTest] ${failures === 0 ? 'ALL PASSED' : `${failures} FAILURE(S)`}`)
if (failures > 0) process.exit(1)
