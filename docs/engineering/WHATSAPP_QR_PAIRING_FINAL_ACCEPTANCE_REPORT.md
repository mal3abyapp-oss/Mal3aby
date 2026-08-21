# WHATSAPP QR PAIRING — FINAL ACCEPTANCE REPORT

**Date:** 2026-08-21

---

## ROOT CAUSE

`BaileysProvider.logout()` (an explicit, operator-initiated call) has always correctly cleared the local Baileys auth directory on disk. But the `connection.update` handler's own `loggedOut` branch — reached whenever WhatsApp's servers themselves report a genuine logout (e.g. the phone unlinking the device), independent of any explicit `logout()` call — only ever called `setState('logged_out', ...)` and returned. It never cleared the same local auth directory.

## WHY EVERY LINK ATTEMPT FAILED

The stale, WhatsApp-invalidated `creds.json` (`registered: true`) survived on local container disk after the real logout. Every subsequent `start_whatsapp_pairing()` → `initializeConnection()` call re-read those same dead credentials via `useMultiFileAuthState()`, and Baileys attempted to **resume** the old, already-dead identity instead of starting a genuinely fresh, unregistered handshake. WhatsApp's own servers correctly recognized the resumed identity as already logged out and terminated the connection with another `loggedOut` disconnect — **before ever sending the server-side `iq pair-device` stanza that triggers Baileys' own QR emission** (confirmed by reading Baileys' `socket.js` directly: QR generation is entirely server-driven, offered only when the presented identity is not already a dead, registered one — never a client-side decision). Confirmed live: 5 consecutive real production pairing attempts each cycled `connecting → logged_out` in 2–6 seconds, zero QR ever emitted.

**Fix:** the `loggedOut` branch now also clears the local auth directory, mirroring `logout()`'s own pre-existing correct behavior. Deployed as connector image `a513976`.

---

## Matrix

| Item | Result |
|---|---|
| PAIRING REQUEST | PASS |
| POLLER | PASS |
| PROVIDER LIFECYCLE | PASS |
| PROVIDER DISPOSAL | PASS (root-cause was local auth-dir files, not the in-memory provider object — confirmed via direct code trace: `teardownCurrentSocket()` and the top of `doInitializeConnection()` already correctly reset all in-memory per-attempt state) |
| FRESH AUTH STATE | PASS (post-fix; verified live: `generation_claimed → connecting → qr_required`, a real QR emitted) |
| GENERATION FENCING | PASS — correctly claimed generation 19 for the fresh pairing, generation 20 for the post-restart reconnect; no regression to the independent-audit fix |
| QR GENERATION | PASS — real QR payload confirmed via `get_whatsapp_qr()`, live |
| QR PERSISTENCE | PASS — correct `qr_expires_at`, correctly scoped to `club_id` |
| QR UI | PASS — UI-verified: "بانتظار مسح الرمز" with a real rendered QR image and correct instructions |
| QR REFRESH | PASS — observed 5 consecutive auto-refresh cycles over ~4 minutes while awaiting the scan, each correctly extending `qr_expires_at` |
| CONCURRENT PAIRING | NOT independently re-tested this pass (already proven for the generation-claim RPC itself in the prior independent audit; the pairing-specific UI-repeat-click guard was not separately re-exercised here) |
| SESSION PURGE | PASS — confirmed working both directions: purge-on-logout (prior fix, re-confirmed still firing) and persistence-on-connect (new session correctly stored, `has_session=true` after the fresh pairing) |
| PHONE/E164 | PASS (re-confirmed earlier this audit cycle; unchanged) |
| PHONE → JID | PASS (unchanged code path, not touched by this fix) |
| CONNECTED PHONE | PASS — `connected_phone_number` correctly came from the real Baileys socket (`201116505553`), matching the actual account scanned |
| REAL QA SEND | PASS — real booking created, real send, `provider_reference: 3EB0E85AB57C5CD8C1A951`, `attempts: 1`, correct recipient, correct template |
| BOOKING MESSAGE | PASS (the QA send above was a `booking-created` message) |
| PAYMENT MESSAGE | Not re-tested this specific pass (already PRODUCTION-VERIFIED earlier in this engagement; unaffected by this fix) |
| CANCELLATION MESSAGE | Not re-tested this specific pass (already PRODUCTION-VERIFIED earlier; unaffected by this fix) |
| ACADEMY/GUARDIAN MESSAGE | Not re-tested this specific pass (already PRODUCTION-VERIFIED earlier; unaffected by this fix) |
| DUPLICATE SEND PROTECTION | Unaffected by this fix (separate, already-verified mechanism); not re-tested this pass |
| QUEUE RECOVERY | PASS — confirmed no retry storm during the outage window, all affected rows followed the existing capped-retry/backoff schedule |
| CONTAINER RESTART RECOVERY | **PASS** — triggered a real, controlled restart via the documented `/manage/:clubId/restart` route (a new `MANAGEMENT_API_TOKEN` was generated and set, with explicit user authorization, since the existing one's plaintext value was not available in this session). New process claimed generation 20 (correctly N+1 from 19), restored the persisted session from Postgres, and reconnected in under 2 seconds — **no new QR required** |
| TENANT ISOLATION | PASS — re-confirmed live post-reconnect: a real Club B manager account correctly denied (`not authorized`) when attempting to read Club A's now-connected status |
| SECURITY | PASS — no regression to any of the independent audit's earlier findings; the new `MANAGEMENT_API_TOKEN` was set via `wrangler secret put` (never committed, never logged, never printed more than once in this session) |

---

## AUTOMATED TESTS

Connector: **74/74 passing** (68 pre-existing + 6 new — `authDirClearedOnLogoutTest.ts`, wired into `npm test`). `tsc --noEmit` and build both clean.
Frontend: 62/62 passing (32 pre-existing skips, unrelated), 0 lint errors (9 pre-existing warnings, none new), `tsc -b` clean.

---

## BUGS FOUND

1. WhatsApp-side `loggedOut` disconnects never cleared the local Baileys auth directory, causing every subsequent pairing attempt to try resuming a dead session instead of starting fresh — no QR was ever produced.

## BUGS FIXED

1. The above — `connection.update`'s `loggedOut` branch now clears the local auth dir, matching `logout()`'s existing behavior. Deployed, live-verified end-to-end: fresh pairing → real QR → real scan → connected → restart → auto-restore (no QR) → real QA send.

---

## MIGRATIONS

None this pass (pure connector-code fix, no schema/RPC change).

---

## LOCAL HEAD

`8438f6f428d8ed87405f92e545ed4627b7bcddd5`

## ORIGIN/MAIN

`8438f6f428d8ed87405f92e545ed4627b7bcddd5` (confirmed synced via `git fetch` + SHA comparison)

## CONNECTOR VERSION

`a513976` (deployed, confirmed via `wrangler containers info` showing `"image": ".../mala3by-whatsapp-connector:a513976"` and the actual running instance's own generation-claim trace)

## FRONTEND BUNDLE

Unchanged this pass (no frontend files touched by the QR-pairing fix).

---

## PRODUCTION E2E

**PASS.** The complete required chain was proven live, end-to-end, on real production infrastructure:

```
LOGGED OUT
  → LINK WHATSAPP (start_whatsapp_pairing)
  → FRESH PAIRING (generation_claimed: 19, connecting, qr_required)
  → QR (real payload, auto-refreshed 5x over ~4 min while awaiting scan)
  → SCAN (by the user, on their real phone)
  → CONNECTED (connected_phone_number: 201116505553, connected_at set, last_error null)
  → RESTART (via /manage/:clubId/restart, a real controlled container stop+start)
  → AUTO RESTORE (generation_claimed: 20, connecting → connected in <2s, NO new QR)
  → REAL QA SEND (booking-created, provider_reference: 3EB0E85AB57C5CD8C1A951, attempts: 1)
```

Tenant isolation re-confirmed intact post-reconnect. No regression to the independent audit's earlier generation-fencing fix (correctly claimed 19 then 20, strictly increasing, no reset). Test artifacts cleaned up (the one synthetic booking created for this test was deleted after confirming the send).

---

## FINAL VERDICT

## WHATSAPP PRODUCTION ACCEPTANCE PASSED
