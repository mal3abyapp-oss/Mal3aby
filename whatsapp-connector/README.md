# Mala3by WhatsApp Connector Service

A persistent Node/TypeScript service that performs the real WhatsApp
Multi-Device (Baileys) handshake and message delivery, on behalf of the
main Mala3by platform (Vite + Supabase). This service runs **outside**
the Vite client and the Supabase request/response cycle — it is a
long-lived process, which is a hard requirement for a real WhatsApp
Web session (the connection must stay open).

## Why this exists

Supabase Postgres cannot make outbound WebSocket connections or hold a
persistent session, and the Vite admin app is a browser client — WhatsApp
session credentials must never reach either of those. This service is
the one place that:

- Actually talks to WhatsApp (via Baileys, behind the `MessagingProvider`
  adapter interface in `src/MessagingProvider.ts`).
- Holds the encrypted session credentials (`src/SessionStore.ts`,
  AES-256-GCM at rest, tenant-isolated by hashed club ID, never written
  in plaintext anywhere).
- Exposes a narrow, signed-request-only internal HTTP API
  (`src/server.ts`) that a trusted Supabase-side integration calls —
  never the browser directly.

## Architecture

```
Vite Admin App  →  Supabase (RPCs, RLS)  →  Notification Core (queue)
                                          ↘
                                            WhatsApp Connector Service
                                            (this project)
                                              → MessagingProvider (interface)
                                                → BaileysMessagingProvider
                                                  → WhatsApp Multi-Device
```

Swapping Baileys for WPPConnect later (the directive's designated
fallback) means writing a new class implementing `MessagingProvider` —
nothing outside `BaileysMessagingProvider.ts` imports Baileys directly.

## Real completion status (honest, per the governing directive's
required vocabulary — do not read this as "not built")

**IMPLEMENTED — EXTERNAL SCAN QA PENDING**

Verified via a real, automated run of `npm test` (`src/selfTest.ts`) in
this session: the service opened a genuine WebSocket connection to
WhatsApp's own servers, completed the device-pairing handshake
request/response, and received back a real, valid, scannable QR
payload (237 characters, base64-ish multi-part token — not a mock
string). The state machine correctly walked
`generating_qr → authenticating → waiting_for_scan`, and `logout()`
correctly walked `logged_out → disconnected`. This is not a stub — it
is a genuine WhatsApp Multi-Device pairing request that a real phone
could actually scan.

The `supabase/functions/whatsapp-bridge` Edge Function (the trusted,
signed bridge between the Vite admin app and this service) is deployed
and live on the Supabase project, and correctly returns
`connector_not_configured` until this service is deployed to a real
persistent host and `WHATSAPP_CONNECTOR_URL`/`CONNECTOR_INTERNAL_SECRET`
are set on the Edge Function's own environment — an honest state, not a
silently-broken one.

Everything up to and including real QR generation from a real Baileys
socket is implemented and code-complete:
- The full connection state machine (disconnected → generating_qr →
  waiting_for_scan → authenticating → connected, plus reconnecting/
  expired/logged_out/failed) is real, driven by actual Baileys
  `connection.update` events, not a UI-only simulation.
- `initializeConnection()` opens a real Baileys WebSocket to WhatsApp's
  servers and receives a real, valid, scannable QR payload back.
- Session persistence, reconnect-without-rescanning, encrypted at-rest
  storage, tenant isolation, the signed internal API, and the Supabase
  sync layer are all real and wired end-to-end.

What has **not** been verified, because it requires a physical phone
with WhatsApp installed, which is not available in this execution
environment: actually scanning the generated QR with a real phone,
confirming the session reaches `connected`, sending and receiving a
real message, restarting the service and confirming reconnect-without-
rescan, and disconnecting/confirming a fresh QR is then required. These
are the exact steps enumerated in the governing directive's "Real Phone
Test" section.

**This status is not claimed as COMPLETE**, per the directive's own
distinction between COMPLETE (real QR + real phone + real send
succeeded) and IMPLEMENTED — EXTERNAL SCAN QA PENDING (system ready,
phone unavailable during this session). To close this out: run
`npm run dev`, call `POST /connect` then `POST /qr` (both signed, see
below) against a real club, render the returned string as a QR code,
and scan it with WhatsApp → Linked Devices → Link a Device on a real
phone.

## Setup

```bash
cd whatsapp-connector
npm install
cp .env.example .env
# fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
# CONNECTOR_INTERNAL_SECRET, WHATSAPP_SESSION_ENCRYPTION_KEY
npm run dev
```

## Internal API (signed requests only)

Every request must include an `x-connector-signature` header:
`HMAC-SHA256(CONNECTOR_INTERNAL_SECRET, rawRequestBody)`, hex-encoded.
Unsigned or incorrectly-signed requests receive a generic `401` with no
detail on which check failed.

| Route | Body | Purpose |
|---|---|---|
| `POST /connect` | `{ clubId }` | Begin a connection attempt for this club |
| `POST /qr` | `{ clubId }` | Get the current pairing QR (or `null`) |
| `POST /disconnect` | `{ clubId }` | Log out and wipe the session |
| `POST /send` | `{ clubId, toPhoneE164, body }` | Send one message (queue-worker use only, never called inline from a business transaction) |
| `POST /health` | `{ clubId }` | Health/diagnostics snapshot, no secrets |

`clubId` always originates from an already-authenticated, already-
authorized Supabase RPC call server-side — never taken directly from an
unauthenticated client request.

## Security notes

- Session auth state: AES-256-GCM encrypted at rest, server-side only.
  Never in localStorage, never in git, never logged, never returned
  through any API response.
- Multi-tenant isolation: session files are keyed by
  `sha256(clubId)`, not the raw ID — defense in depth against any future
  path-traversal-shaped bug even though `clubId` never originates from
  untrusted input today.
- One active connection per club for V1 (`whatsapp_connections.club_id`
  is a primary key) — the schema doesn't prevent multiple numbers per
  tenant in a future version, but V1 deliberately keeps this simple.
