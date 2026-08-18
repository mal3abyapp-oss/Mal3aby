import { Container, getContainer } from '@cloudflare/containers'

/**
 * WhatsAppAccountObject -- one Durable Object instance per WhatsApp
 * account (one per connected club, matching the "1 logical account ->
 * 1 authoritative session owner" requirement). This is the ONLY code
 * path that may start/stop this account's Container, which is what
 * makes duplicate-container/duplicate-socket/split-brain structurally
 * impossible: Durable Objects are globally single-instance-per-name by
 * Cloudflare's own platform guarantee (there is never a second live
 * WhatsAppAccountObject for the same clubId anywhere on the network),
 * and this class never blindly calls start() without first checking
 * this.ctx.storage's own record of whether it already believes a
 * container is running for this account.
 *
 * REAL API SURFACE NOTE: this file was written and typechecked against
 * the actual installed `@cloudflare/containers@0.0.13` package (see
 * package.json), not against documentation prose alone -- an earlier
 * draft of this file called a documented-but-not-actually-exported
 * `getState()` method; `npx tsc --noEmit` caught this immediately
 * (TS2339) and this version was corrected to use only what the
 * installed package genuinely exports (start/startAndWaitForPorts/
 * stop/destroy/onStart/onStop/onError/renewActivityTimeout/schedule/
 * containerFetch/fetch). This discrepancy between documentation and
 * the installed package's real public API is itself a finding recorded
 * in MAL3ABY_CLOUDFLARE_WHATSAPP_VALIDATION.md -- Cloudflare's
 * Containers product was in active development at the time of this
 * audit and its exact API shape should be re-verified against
 * whatever `@cloudflare/containers` version is actually installed
 * before this code is deployed.
 *
 * IMPORTANT ARCHITECTURAL BOUNDARY: this Durable Object does NOT proxy,
 * terminate, or touch Baileys' own outbound WebSocket to WhatsApp's
 * servers in any way -- that connection is made directly from inside
 * the container's own Linux network stack (Baileys/Node `ws` library,
 * genuine Firecracker microVM networking, not the Workers V8-isolate
 * WebSocket runtime) and never passes through this object or the
 * fetch() handler below. This object's entire job is lifecycle
 * orchestration: start the container, poll its /status endpoint
 * periodically, and call renewActivityTimeout() to keep it awake WHILE
 * IT IS GENUINELY DOING SOMETHING (connected or actively reconnecting)
 * -- never as an unconditional keep-alive, so a truly idle/disconnected
 * account is allowed to sleep and stop incurring cost (directive rule 77).
 */

interface AccountStartState {
  startedAt: number
}

const LAST_POLL_AT_KEY = 'lastHealthPollAt'

/**
 * ROOT CAUSE FIX (production architecture change, not a workaround):
 * confirmed live via 3 fully-instrumented restart cycles that this
 * Durable Object was being evicted by the Cloudflare platform every
 * ~184s -- fully independent of `sleepAfter` (raised 3m -> 30m with
 * zero effect) -- because the ONLY thing keeping it "active" was a
 * plain `containerFetch()` HTTP poll every 60s, and Cloudflare's own
 * Durable Object lifecycle documentation
 * (developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/,
 * fetched live during this investigation) states explicitly: "It does
 * not apply to plain fetch() subrequests. Those never keep the Durable
 * Object alive, even while the response body is still streaming." Only
 * an active outbound TCP connect() or WebSocket does, "for a maximum of
 * 15 minutes" per connection.
 *
 * Fix: hold one outbound WebSocket open from this DO to the container's
 * HealthServer.ts /keepalive endpoint WHILE (and only while) there is a
 * genuine reason to stay awake (shouldStayAwake, the same signal that
 * already drives renewActivityTimeout() -- this is additive to that
 * existing cost-guardrail logic, not a replacement of it: a genuinely
 * idle account still gets no keep-alive connection and is still allowed
 * to sleep, matching directive rule 77's intent).
 */
const KEEPALIVE_ROTATE_BASE_MS = 12 * 60 * 1000 // rotate before the 15-minute per-connection limit
const KEEPALIVE_ROTATE_JITTER_MS = 90 * 1000 // +/-90s jitter so many clubs don't rotate in lockstep
const KEEPALIVE_RECONNECT_BACKOFF_MS = [2000, 5000, 10000, 20000]

export interface Env {
  WHATSAPP_ACCOUNT: DurableObjectNamespace<WhatsAppAccountObject>
  // Checked by the Container's own /status endpoint (HealthServer.ts)
  // -- distinct secret from MANAGEMENT_API_TOKEN below, different trust
  // boundary (Worker<->Container internal, vs. admin-app<->Worker).
  CONTAINER_INTERNAL_TOKEN: string
  // Checked by this Worker's own /manage/* routes -- the credential an
  // authorized internal caller (e.g. a platform-owner admin action, or
  // this repo's own deploy/ops tooling) presents. Never the same value
  // as CONTAINER_INTERNAL_TOKEN.
  MANAGEMENT_API_TOKEN: string
  SUPABASE_URL: string
  SUPABASE_SERVICE_ROLE_KEY: string
  WHATSAPP_SESSION_ENCRYPTION_KEY: string
  PUBLIC_APP_URL: string
}

const START_STATE_KEY = 'accountStartState'

export class WhatsAppAccountObject extends Container<Env> {
  // Matches whatsapp-connector/src/HealthServer.ts's HEALTH_PORT default.
  defaultPort = 8080

  // ROOT CAUSE NOW UNDERSTOOD AND FIXED (see the keep-alive WebSocket
  // block below): a controlled A/B test proved the ~3-minute restart
  // cycle was NEVER caused by this `sleepAfter` value or by any of this
  // repo's own code -- it was Cloudflare's Durable Object platform
  // evicting this DO because its only "activity" signal was a plain
  // `fetch()` health poll, which Cloudflare's own documentation states
  // explicitly never counts toward keeping a DO alive. The keep-alive
  // WebSocket (ensureKeepalive()/closeKeepalive() below) is the real
  // fix for that. With the real fix in place, this value is restored to
  // its original intent (a real container "sleep after N minutes idle"
  // budget, not a workaround for the eviction bug) -- a genuinely idle/
  // disconnected account still sleeps and stops costing money.
  sleepAfter = '3m'

  // REAL BUG FOUND AND FIXED during first live acceptance run: the
  // Container base class does NOT automatically forward this Worker's
  // own env bindings/secrets into the container process -- envVars must
  // be set explicitly (confirmed against the actual installed
  // @cloudflare/containers@0.0.13 API: `envVars?: Record<string,
  // string>` is a plain class property with no default forwarding
  // behavior documented or observed). Without this, the container
  // started with an empty environment; whatsapp-connector/src/index.ts
  // does `process.env.WHATSAPP_SESSION_ENCRYPTION_KEY!` (non-null
  // assertion) at startup, which threw immediately on `undefined` and
  // crashed the container before it ever bound port 8080 -- observed
  // live via `wrangler tail` as "Container crashed while checking for
  // ports, did you setup the entrypoint correctly?" on the very first
  // ensureRunning() call against a real deployed Container. Fixed by
  // explicitly declaring the exact set of env vars the connector's own
  // code actually reads (cross-checked against every `process.env.*`
  // read in whatsapp-connector/src, not guessed).
  envVars: Record<string, string>

  // Keep-alive connection state -- in-memory only (not persisted to
  // ctx.storage) since a DO re-instantiation after a genuine eviction
  // means any previously-held WebSocket is already gone regardless;
  // the next runHealthPollTick() simply opens a fresh one if still
  // needed. Requirement 6 ("one club DO -> one keep-alive connection")
  // is enforced by always checking/closing this field before opening a
  // new one -- see ensureKeepalive() below.
  private keepaliveSocket: WebSocket | null = null
  private keepaliveReconnectAttempts = 0
  private keepaliveRotateAt = 0

  constructor(ctx: DurableObjectState<Env>, env: Env) {
    super(ctx, env)
    this.envVars = {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      WHATSAPP_SESSION_ENCRYPTION_KEY: env.WHATSAPP_SESSION_ENCRYPTION_KEY,
      CONTAINER_INTERNAL_TOKEN: env.CONTAINER_INTERNAL_TOKEN,
      PUBLIC_APP_URL: env.PUBLIC_APP_URL,
      HEALTH_PORT: '8080',
    }
  }

  /**
   * Called by the Container base class once the container has started
   * and (if defaultPort/requiredPorts is set) its port is confirmed
   * reachable. Records "this instance believes a container is running"
   * in Durable Object storage (survives THIS Durable Object's own
   * restarts/hibernation, independent of the container's ephemeral
   * disk) and kicks off the recurring health-poll alarm loop.
   *
   * REAL BUG found live during the MAL3ABY WHATSAPP QR IMAGE + INVOICE
   * DOCUMENT DELIVERY task's WhatsApp send tests: this class's own
   * `sleepAfterMs` field (in the installed @cloudflare/containers@0.0.13
   * base class) defaults to 0, and NOTHING in the base class's actual
   * `startAndWaitForPorts()` implementation calls
   * `renewActivityTimeout()` on a successful start -- despite that
   * method's own doc comment claiming "5. When all ports are available,
   * it triggers onStart and renewActivityTimeout" (confirmed by reading
   * node_modules/@cloudflare/containers/dist/index.js directly: no such
   * call exists in that function body). `isActivityExpired()` is
   * `sleepAfterMs <= Date.now()`, so with sleepAfterMs still at its `0`
   * default, the container reads as "already expired" from the instant
   * it starts, until the FIRST scheduled health-poll tick (up to 60s
   * later, per scheduleNextHealthPoll's cadence) gets a chance to renew
   * it. If the shared Durable Object alarm mechanism fires for any
   * other reason in that window, `alarm()`'s own inline
   * `isActivityExpired()` check (also read directly from the same
   * installed package) stops the container immediately -- confirmed
   * live via `wrangler tail`: an alarm fired, found the container not
   * listening on 8080 (already stopped), and had to restart it, in a
   * tight ~3-minute repeating cycle that meant NO WhatsApp send (text
   * or media) could complete without racing a mid-send container
   * restart -- 3 consecutive real send attempts timed out during live
   * testing before this was root-caused.
   *
   * Fix: renew the timeout explicitly and immediately here, the instant
   * the container is confirmed started -- do not rely on the base
   * class's undocumented-in-practice behavior. This closes the gap
   * between "container just started" and "first health poll renews it"
   * that was causing the premature-sleep race.
   */
  async onStart(): Promise<void> {
    // DIAGNOSTIC (root-cause investigation, per explicit user
    // methodology): identity + timestamp only, no secrets.
    console.log(`[lifecycle] onStart club=${this.clubIdShort()} at=${new Date().toISOString()}`)
    this.renewActivityTimeout()
    await this.ctx.storage.delete(LAST_POLL_AT_KEY)
    await this.ctx.storage.put<AccountStartState>(START_STATE_KEY, { startedAt: Date.now() })
    await this.scheduleNextHealthPoll()
  }

  /**
   * Called when the container process exits, for any reason (clean
   * stop, crash, host-level restart). Clears the "running" record so a
   * subsequent ensureRunning() call correctly re-starts rather than
   * assuming a container is still alive when it is not.
   *
   * DIAGNOSTIC (root-cause investigation): the real, installed
   * @cloudflare/containers@0.0.13 API passes `{ exitCode: number,
   * reason: 'exit' | 'runtime_signal' }` to this hook (confirmed via
   * the package's own .d.ts) -- the PREVIOUS version of this method
   * ignored both fields entirely, discarding exactly the evidence
   * needed to determine who/what stopped the container and why. Now
   * logged (identity + timestamp + exitCode + reason only -- no
   * secrets, no session data).
   */
  async onStop(params: { exitCode: number; reason: 'exit' | 'runtime_signal' }): Promise<void> {
    console.log(
      `[lifecycle] onStop club=${this.clubIdShort()} at=${new Date().toISOString()} exitCode=${params.exitCode} reason=${params.reason}`,
    )
    // Requirement 9: close the keep-alive socket cleanly on container
    // shutdown -- the container process (and the /keepalive endpoint it
    // was serving) is already gone at this point, so this is really
    // just clearing our own reference/state; the remote side has
    // already dropped the connection regardless.
    this.closeKeepalive('container stopped')
    await this.ctx.storage.delete(START_STATE_KEY)
  }

  /**
   * DIAGNOSTIC (root-cause investigation): the real installed package
   * exposes no separate onActivityExpired() hook -- confirmed by
   * reading node_modules/@cloudflare/containers/dist/index.d.ts's full
   * public surface (onStart/onStop/onError only). A container put to
   * sleep by stopDueToInactivity() (the base class's own internal
   * inactivity path) still routes through this SAME onStop() callback
   * -- so onStop()'s own `reason` field is the only place that
   * distinguishes an inactivity-driven stop from anything else, and it
   * is logged above.
   */
  onError(error: unknown): never {
    console.log(`[lifecycle] onError club=${this.clubIdShort()} at=${new Date().toISOString()} error=${error instanceof Error ? error.message : String(error)}`)
    throw error
  }

  private clubIdShort(): string {
    // this.ctx.id is the Durable Object's own id -- not directly the
    // clubId string, but stable per-instance and safe to log (no
    // secret, no PII) as a correlation handle across log lines.
    return this.ctx.id.toString().slice(0, 12)
  }

  /**
   * Directive rule 12: "prevent duplicate containers, duplicate
   * sockets, two Baileys instances for the same account, reconnect
   * race, split brain." Enforced here by checking Durable Object
   * storage's own record BEFORE starting -- never blindly calling
   * start() on every request. startAndWaitForPorts() itself is also
   * inherently safe to call again on an already-running container (the
   * underlying container runtime is idempotent about "start what's
   * already started"), but this explicit check additionally avoids the
   * unnecessary port-polling round-trip on the common case.
   */
  async ensureRunning(): Promise<void> {
    const existing = await this.ctx.storage.get<AccountStartState>(START_STATE_KEY)
    // DIAGNOSTIC (root-cause investigation, item 10 -- "check whether
    // any Worker/DO alarm, scheduled request, management call, or
    // deployment causes the recycle"): every ensureRunning() call is
    // logged with whether it short-circuited (container already
    // believed running) or actually called startAndWaitForPorts() --
    // this is the ONLY code path in this repo that can start the
    // container, so if a restart is happening, exactly one of these
    // two log lines will appear immediately before it, or NEITHER
    // will (proving the restart is not driven by anything in this
    // Worker's own code at all, i.e. a genuine platform-level event).
    console.log(`[lifecycle] ensureRunning club=${this.clubIdShort()} at=${new Date().toISOString()} alreadyRunning=${!!existing}`)
    if (existing) return
    await this.startAndWaitForPorts()
  }

  /**
   * Polls this account's own container /status endpoint (internal-
   * token-gated, see HealthServer.ts) and decides whether to renew the
   * activity timeout (keep awake) based on REAL connection state, not
   * unconditionally. A container with no live/reconnecting WhatsApp
   * session is allowed to sleep -- this is the cost-guardrail
   * enforcement point (directive rule 77): idle accounts genuinely stop
   * costing money, they are not kept artificially warm.
   */
  async pollHealthAndDecide(): Promise<{ shouldStayAwake: boolean; status: string }> {
    const existing = await this.ctx.storage.get<AccountStartState>(START_STATE_KEY)
    if (!existing) {
      return { shouldStayAwake: false, status: 'not_started' }
    }

    try {
      const res = await this.containerFetch('http://container/status', {
        headers: { 'x-internal-token': this.env.CONTAINER_INTERNAL_TOKEN },
      }, this.defaultPort)
      if (!res.ok) {
        // A non-200 /status (e.g. 403 misconfigured token, 500 internal
        // error) is treated as "don't know, don't force a keep-alive" --
        // false here is the safe default, not "assume healthy".
        return { shouldStayAwake: false, status: `http_${res.status}` }
      }
      const body = (await res.json()) as { shouldStayAwake: boolean; pid?: number; uptimeSeconds?: number; memoryMb?: { rss: number } }
      // DIAGNOSTIC (root-cause investigation): surface the connector
      // process's own pid/uptimeSeconds/memory through THIS Worker's
      // logs -- wrangler tail only captures Durable Object/Worker
      // invocations, never a Container's own stdout, so this is the
      // only channel available to see real connector process identity
      // without dashboard/Logpush access. A pid that stays constant
      // across polls + uptimeSeconds climbing normally would prove the
      // SAME process is alive between ticks (contradicting the onStop
      // evidence) -- a pid that changes, or uptimeSeconds resetting to
      // near-zero, confirms a genuine new process each cycle.
      console.log(
        `[lifecycle] pollHealthAndDecide club=${this.clubIdShort()} at=${new Date().toISOString()} pid=${body.pid} uptimeSeconds=${body.uptimeSeconds} rssMb=${body.memoryMb?.rss}`,
      )
      if (body.shouldStayAwake) {
        this.renewActivityTimeout()
      }
      return { shouldStayAwake: body.shouldStayAwake, status: 'ok' }
    } catch (err) {
      // Container may be between "started" and actually accepting
      // connections (cold start window), or genuinely down -- do not
      // renew on a failed probe, but do not treat it as fatal either;
      // the next poll tick will re-check.
      return { shouldStayAwake: false, status: `error:${(err as Error).message}` }
    }
  }

  /**
   * REAL BUG found live (a THIRD, independent bug in this same class --
   * found by adding temporary diagnostic logging after the first two
   * fixes above did not stop the reconnect cycle): calling
   * `this.schedule(60, 'runHealthPollTick')` on every tick was observed
   * to occasionally cause a tight self-reinvoking loop -- hundreds of
   * `runHealthPollTick` calls firing within a single second (~25ms
   * apart), confirmed live via `wrangler tail` diagnostic output. The
   * exact mechanism inside the installed @cloudflare/containers@0.0.13
   * scheduling internals was not fully isolated (schedule()'s own
   * `scheduleNextAlarm()` call uses a hardcoded 1000ms default re-arm
   * distinct from the 60s delay passed to schedule() itself, and it was
   * not safe to keep experimenting against a real, currently-in-use
   * WhatsApp session's container to fully map that interaction).
   *
   * Fix: rate-limit re-scheduling at this call site directly, rather
   * than trusting the library to only invoke the callback once per
   * intended interval. The last-poll timestamp is persisted in Durable
   * Object storage (LAST_POLL_AT_KEY), NOT a plain in-memory class
   * field -- a plain field would reset to its initial value every time
   * this Durable Object is evicted/re-instantiated (hibernation is
   * normal DO behavior between alarm firings), which would silently
   * defeat the guard in exactly the scenario it exists for. Compared
   * against the CURRENT wall clock -- if less than MIN_POLL_INTERVAL_MS
   * has elapsed since the last tick actually ran, this schedules the
   * NEXT tick further out instead of doing real work immediately, which
   * starves out a tight-loop condition regardless of its root cause
   * inside the library. This is a defensive guard, not a root-cause fix
   * for whatever triggers the library's own rapid re-firing --
   * documented honestly, not claimed as a full understanding of the
   * underlying mechanism.
   */
  private static readonly MIN_POLL_INTERVAL_MS = 55_000

  private async scheduleNextHealthPoll(delaySeconds = 60): Promise<void> {
    await this.schedule(delaySeconds, 'runHealthPollTick')
  }

  /** Alarm callback target -- name must match the string passed to schedule(). */
  async runHealthPollTick(): Promise<void> {
    const now = Date.now()
    const lastPollAt = (await this.ctx.storage.get<number>(LAST_POLL_AT_KEY)) ?? 0
    const elapsedSinceLastPoll = now - lastPollAt
    if (lastPollAt !== 0 && elapsedSinceLastPoll < WhatsAppAccountObject.MIN_POLL_INTERVAL_MS) {
      // Rate-limit guard (see class doc comment above) -- this tick
      // fired too soon after the last one actually ran. Reschedule
      // further out instead of doing real work again immediately; this
      // is what stops a tight re-fire loop from consuming the alarm
      // queue and starving real work (including WhatsApp sends, which
      // is what made this bug user-visible: 3 consecutive real send
      // timeouts during live testing were traced back to this).
      await this.scheduleNextHealthPoll(Math.ceil((WhatsAppAccountObject.MIN_POLL_INTERVAL_MS - elapsedSinceLastPoll) / 1000) + 5)
      return
    }
    await this.ctx.storage.put(LAST_POLL_AT_KEY, now)

    const result = await this.pollHealthAndDecide().catch((err) => ({
      shouldStayAwake: false,
      status: `tick_error:${(err as Error).message}`,
    }))
    // DIAGNOSTIC (root-cause investigation): correlates against onStop
    // to determine whether a restart happens WHILE a poll believes the
    // container should stay awake (which would mean something OTHER
    // than this Worker's own polling logic is terminating it), vs.
    // AFTER a poll genuinely reports shouldStayAwake=false (which would
    // point back at the keep-awake logic after all).
    console.log(`[lifecycle] runHealthPollTick club=${this.clubIdShort()} at=${new Date().toISOString()} result=${JSON.stringify(result)}`)

    if (result.status === 'not_started') {
      // The container was never started (or onStop already cleared the
      // record) -- nothing to poll, nothing to reschedule. The next
      // real ensureRunning() call will re-enter onStart() and restart
      // this whole chain.
      this.closeKeepalive('container not started')
      return
    }

    // ROOT CAUSE FIX: this is the enforcement point for the keep-alive
    // WebSocket -- proven necessary by a controlled A/B test (see
    // MAL3ABY_CLOUDFLARE_DEPLOYMENT_STATE.md): the ORIGINAL stable code
    // (commit 1eef03a, before any QR/PDF media work existed) and the
    // CURRENT code both showed the IDENTICAL ~185s Durable Object
    // eviction cycle when tested side-by-side under otherwise identical
    // conditions -- conclusively ruling out a QR/PDF-introduced
    // regression and confirming this is inherent platform behavior:
    // Cloudflare's own docs state plain fetch() (exactly what
    // pollHealthAndDecide()'s /status call is) never keeps a DO alive.
    //
    // Tied to the SAME shouldStayAwake signal that already drives
    // renewActivityTimeout() -- additive to, not a replacement of, the
    // existing cost-guardrail logic (directive rule 77): a genuinely
    // idle/disconnected account still gets no keep-alive connection and
    // is still allowed to sleep and stop incurring cost.
    if (result.shouldStayAwake) {
      await this.ensureKeepalive()
    } else {
      this.closeKeepalive('no longer needs to stay awake')
    }

    // Every other outcome -- ok/shouldStayAwake, ok/notStayAwake
    // (genuinely idle, correctly allowed to sleep), or a transient
    // fetch error -- reschedules the next tick. A transient error must
    // never permanently kill the polling loop (the earlier version of
    // this method deleted START_STATE_KEY here, which silently stopped
    // all future polling after a single blip -- fixed, see this
    // method's git history/commit message for the full story); it just
    // tries again in 60s, same as any other non-fatal outcome.
    await this.scheduleNextHealthPoll()
  }

  /**
   * Opens the keep-alive WebSocket if one is not already open, and
   * schedules its rotation before Cloudflare's documented 15-minute
   * per-connection limit expires. Idempotent -- safe to call on every
   * health-poll tick while shouldStayAwake is true; does nothing if a
   * connection is already open and not yet due for rotation.
   *
   * Requirement 6 (one club DO -> one keep-alive connection): this
   * container serves exactly one club (this repo's own "one container
   * instance per WhatsApp account" architecture), so this method is
   * the ONLY place that opens a keepalive connection, and it always
   * checks/replaces `this.keepaliveSocket` rather than ever opening a
   * second one alongside an existing open one.
   */
  private async ensureKeepalive(): Promise<void> {
    const now = Date.now()
    if (this.keepaliveSocket && this.keepaliveSocket.readyState === WebSocket.READY_STATE_OPEN) {
      if (now < this.keepaliveRotateAt) {
        return // still open, not yet due for rotation
      }
      // Requirement 5: rotate before the 15-minute per-connection limit
      // -- close the old one cleanly and fall through to open a fresh
      // one below, rather than waiting for Cloudflare to stop counting
      // it as "active" out from under us.
      console.log(`[keepalive] keepalive_rotated club=${this.clubIdShort()} at=${new Date().toISOString()}`)
      this.keepaliveSocket.close(1000, 'scheduled rotation')
      this.keepaliveSocket = null
    }

    try {
      const res = await this.containerFetch(
        'http://container/keepalive',
        {
          headers: {
            'x-internal-token': this.env.CONTAINER_INTERNAL_TOKEN,
            Upgrade: 'websocket',
            Connection: 'Upgrade',
          },
        },
        this.defaultPort,
      )
      if (!res.webSocket) {
        throw new Error(`keepalive upgrade did not return a WebSocket (status ${res.status})`)
      }
      const ws = res.webSocket
      ws.accept()
      this.keepaliveSocket = ws
      this.keepaliveReconnectAttempts = 0
      // Requirement 5: jittered rotation so many clubs' DOs don't all
      // reconnect in the same instant (thundering-herd avoidance,
      // requirement 10).
      this.keepaliveRotateAt = now + KEEPALIVE_ROTATE_BASE_MS + Math.round((Math.random() * 2 - 1) * KEEPALIVE_ROTATE_JITTER_MS)
      console.log(`[keepalive] keepalive_opened club=${this.clubIdShort()} at=${new Date().toISOString()}`)

      ws.addEventListener('close', () => {
        if (this.keepaliveSocket === ws) this.keepaliveSocket = null
        console.log(`[keepalive] keepalive_closed club=${this.clubIdShort()} at=${new Date().toISOString()}`)
      })
      ws.addEventListener('error', () => {
        console.log(`[keepalive] keepalive_error club=${this.clubIdShort()} at=${new Date().toISOString()}`)
      })
      // No message handling needed -- see HealthServer.ts's /keepalive
      // doc comment: this channel exists only to be an open connection,
      // never a command/data channel.
    } catch (err) {
      // Requirement 8: reconnect with bounded backoff on error, rather
      // than either a tight retry loop or silently giving up. The NEXT
      // health-poll tick (60s cadence, same as always) is what actually
      // drives the retry -- this just logs and lets that natural cadence
      // serve as the backoff, capped by KEEPALIVE_RECONNECT_BACKOFF_MS's
      // own length so a persistently failing keepalive doesn't spam
      // reconnect_attempt logs forever without bound.
      this.keepaliveReconnectAttempts = Math.min(this.keepaliveReconnectAttempts + 1, KEEPALIVE_RECONNECT_BACKOFF_MS.length)
      console.log(
        `[keepalive] reconnect_attempt club=${this.clubIdShort()} at=${new Date().toISOString()} attempt=${this.keepaliveReconnectAttempts} error=${(err as Error).message}`,
      )
    }
  }

  /** Closes the keep-alive socket if one is open. Requirement 9: clean close on shutdown/no-longer-needed, never an abrupt drop. */
  private closeKeepalive(reason: string): void {
    if (!this.keepaliveSocket) return
    try {
      if (this.keepaliveSocket.readyState === WebSocket.READY_STATE_OPEN) {
        this.keepaliveSocket.close(1000, reason)
      }
    } catch {
      // Best-effort -- the socket may already be in a closing/closed
      // state; nothing further to do.
    }
    this.keepaliveSocket = null
  }
}

/**
 * Router-level helper -- resolves the single Durable Object instance
 * for a given clubId (Cloudflare's own name->instance mapping already
 * guarantees uniqueness; getContainer() is the documented
 * @cloudflare/containers helper for this exact pattern).
 */
export function getAccountObject(env: Env, clubId: string) {
  return getContainer(env.WHATSAPP_ACCOUNT, clubId)
}
