# Mal3aby WhatsApp Connector

A standalone Node/TypeScript service that performs the real WhatsApp
Multi-Device (Baileys) handshake and message delivery on behalf of the
Mal3aby app. It exists as a separate service because Mal3aby itself is
a Vite + React SPA with **no Node backend** -- all its server logic
lives in Supabase (Postgres RPCs, RLS, Deno Edge Functions). Baileys
needs a long-lived Node process holding a real WebSocket connection to
WhatsApp's servers; that cannot run inside a stateless Edge Function
invocation or inside the browser.

## Why Baileys

Meta's Cloud API, the official WhatsApp Business API, and paid
third-party messaging services are explicitly out of scope for this
integration (see `AUTONOMOUS_DECISION_LOG.md` D-016). Baileys drives
WhatsApp's own Multi-Device protocol directly over a WebSocket:
TypeScript-native, no mandatory Puppeteer/Chromium dependency, and
already proven end-to-end in this exact codebase in a prior (since
removed, for unrelated reasons -- see D-013) implementation.

## Architecture

```
Business RPC (create_booking, record_payment, ...)
  -> emit_notification_event()          [Postgres, Notification Core]
  -> queue_whatsapp_notification()      [Postgres, task #93]
  -> enqueue_notification()             [Postgres, Notification Core]
       |
       v
notification_queue (channel = 'whatsapp')
       |
       v  (polled)
QueueConsumer  ->  TenantConnectionManager  ->  WhatsAppProvider (interface)
                                                       |
                                                       v
                                              BaileysProvider (implementation)
                                                       |
                                                       v
                                              real WhatsApp WebSocket
```

**`WhatsAppProvider`** (`src/WhatsAppProvider.ts`) is the adapter
boundary. Only `BaileysProvider.ts` imports `@whiskeysockets/baileys`.
If Baileys is ever replaced, only a new class implementing this
interface is needed -- nothing else in this service, and nothing in the
main Mal3aby app (which never imports anything from this directory),
changes.

**No inbound HTTP API.** The admin app never talks to this process
directly. It writes *intent* into Postgres via
`start_whatsapp_pairing()` / `disconnect_whatsapp()`
(`supabase/migrations/20260817110000_whatsapp_connection_model_v2.sql`),
and this service notices via `ConnectionRequestPoller` and acts on it.
This keeps the connector's network exposure to zero inbound ports.

**Tenant isolation**, enforced at three independent layers:
1. `TenantConnectionManager` holds one `WhatsAppProvider` per `clubId`
   in a `Map` -- every method takes an explicit `clubId` and only
   touches that entry.
2. `BaileysProvider`'s local auth-state directory name is a SHA-256
   hash of `clubId`, never the raw UUID as a path segment.
3. Postgres: `whatsapp_accounts` has zero RLS SELECT/UPDATE grants at
   all -- reachable only through narrow SECURITY DEFINER RPCs, all of
   which take an explicit `club_id` and (for the club-facing RPCs)
   check `auth.uid()` + `has_permission('manage_whatsapp_connection',
   club_id)`.

**Session persistence.** Baileys' auth state is encrypted (AES-256-GCM,
`src/SessionStore.ts`) and stored in Postgres via
`whatsapp_connector_store_session()` on every `creds.update`. On
startup, `TenantConnectionManager.restoreAllPersistedSessions()` pulls
each club's encrypted blob back down, decrypts it onto disk, and
reconnects -- so a service restart (or a move to a fresh host/container)
does not force every connected club to re-scan a QR code. Credentials
are never stored in browser localStorage, never logged, and never
committed to git.

**Queue processing.** `QueueConsumer` polls
`whatsapp_connector_claim_next_batch()` (which uses `FOR UPDATE SKIP
LOCKED`, so a restarted or duplicate connector instance never
double-sends). Each row's `template_key` + `variables` are rendered via
`src/templates.ts` (centralized, ar/en) and sent through
`TenantConnectionManager`. Outcomes are reported via
`whatsapp_connector_report_send_result()`, which applies a capped
retry policy (1m / 5m / 20m / 60m backoff, 5 attempts max, then
terminal `failed`) -- never an infinite retry loop, and a WhatsApp
outage never blocks or rolls back the booking/payment transaction that
originated the notification (that transaction already committed before
the row ever reached this queue).

## Running locally

```bash
cd whatsapp-connector
npm install
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, WHATSAPP_SESSION_ENCRYPTION_KEY
npm run dev
```

`npm test` runs `src/selfTest.ts`, which opens a real Baileys
connection and waits for a real QR payload from WhatsApp's servers --
proof the integration is real, without requiring a phone scan (that
step is the honest, non-automatable boundary; see the script's own
comments).

## Deployment (out of scope for this phase)

This phase is deliberately local-only. `BaileysProvider` and the rest
of this service have no dependency on where they run, so moving to a
persistent Node service on a VPS/container later requires no changes
to `WhatsAppProvider`, `TenantConnectionManager`, the Notification
Core, or any booking/payment/invoice code -- only where this process is
started and what `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` point at.
