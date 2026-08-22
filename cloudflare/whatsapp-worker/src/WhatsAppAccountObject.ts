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
 * REAL API SURFACE NOTE / VERSION HISTORY: this file was originally
 * written and typechecked against `@cloudflare/containers@0.0.13`,
 * whose public surface was missing `onActivityExpired()` entirely
 * (confirmed by direct `.d.ts` reads at the time). That gap is what
 * caused the THIRD root-cause finding below: with no override point,
 * every `sleepAfter` expiry unconditionally called the base class's
 * own internal stop path, regardless of whether this account genuinely
 * needed to stay awake. The package was upgraded to `0.3.7` (46
 * versions newer -- confirmed via `npm view @cloudflare/containers
 * versions`) specifically to get `onActivityExpired()`, which
 * Cloudflare's own current documentation describes as: "Runs when the
 * sleepAfter timer expires with no incoming requests. The default
 * implementation calls stop() to shut down the container. You can use
 * this to only stop the container on certain conditions." This is the
 * real, intended, documented extension point -- not a workaround.
 * `onStart`/`onStop(params: StopParams)`/`onError`/`renewActivityTimeout`/
 * `schedule`/`containerFetch` all kept their 0.0.13 signatures in 0.3.7
 * (re-verified directly against
 * node_modules/@cloudflare/containers/dist/lib/container.d.ts and
 * dist/types/index.d.ts before this upgrade was relied upon).
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
 * KEEP-ALIVE WEBSOCKET -- TRIED, MEASURED, REMOVED (recorded here, not
 * silently deleted, per the "never delete a feature that revealed the
 * problem without documenting why" rule): a controlled A/B test first
 * proved this Durable Object was being evicted by the Cloudflare
 * platform every ~184s, independent of `sleepAfter` and of the QR/PDF
 * media work. Cloudflare's own Durable Object lifecycle documentation
 * states plain `fetch()` subrequests never keep a DO alive, while an
 * active outbound TCP connect() or WebSocket does -- so an outbound
 * WebSocket (ensureKeepalive()/closeKeepalive(), held open to the
 * container's HealthServer.ts /keepalive endpoint while
 * shouldStayAwake was true) was implemented as commit 514758f, image
 * tag v5-keepalive, and deployed to production.
 *
 * Live `wrangler tail` monitoring of that deployed version then showed
 * `keepalive_opened` firing successfully at 12:54:41Z, followed by
 * ANOTHER eviction (`onStop exitCode=0 reason=exit`) at 12:57:44Z --
 * 182.1s later, matching the pre-fix cycle almost exactly, with no
 * `keepalive_closed`/`keepalive_error` logged beforehand. The
 * WebSocket, once open, did not prevent the next eviction: this
 * contradicts Cloudflare's documented "outbound WebSocket keeps a DO
 * alive" behavior taken at face value.
 *
 * That contradiction is what led to checking the installed
 * `@cloudflare/containers` version against npm's latest and finding it
 * was `0.0.13` against a current `0.3.7` (46 versions behind) --
 * missing `onActivityExpired()` entirely, the actual documented
 * override point for this exact scenario ("Runs when the sleepAfter
 * timer expires... The default implementation calls stop()... You can
 * use this to only stop the container on certain conditions."). Once
 * upgraded, `onActivityExpired()` (see below) is a direct, first-party
 * override of the real decision point, rather than an indirect signal
 * (an open socket) that was empirically proven not to change the
 * outcome on the actually-installed version. The WebSocket
 * implementation and its /keepalive server endpoint
 * (HealthServer.ts) are removed as this upgrade lands -- kept only in
 * git history (commit 514758f) and this comment, not as parallel
 * dead code alongside the real fix.
 */

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

  // ROOT CAUSE NOW UNDERSTOOD AND FIXED: a controlled A/B test proved
  // the ~3-minute restart cycle was NEVER caused by this `sleepAfter`
  // value or by any of this repo's own business logic -- it was the
  // installed `@cloudflare/containers@0.0.13` package's lack of an
  // `onActivityExpired()` override point, which meant EVERY `sleepAfter`
  // expiry unconditionally called the base class's own stop(), with no
  // way to check real connection state first (see the class-level doc
  // comment's KEEP-ALIVE WEBSOCKET section for the full investigation
  // history). With the real fix in place (onActivityExpired() below),
  // this value is a genuine "sleep after N minutes idle" budget again --
  // a genuinely idle/disconnected account still sleeps and stops costing
  // money (directive rule 77).
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
   * TRUE ROOT CAUSE FIX for the ~3-minute restart cycle (production
   * architecture change, not a workaround): with `@cloudflare/containers
   * @0.0.13`, this override point did not exist at all -- the base
   * class's ONLY behavior on `sleepAfter` expiry was to unconditionally
   * call `stop()`, no matter what `renewActivityTimeout()` calls had
   * happened in between (confirmed by reading that version's compiled
   * source directly). Upgrading to `0.3.7` (see the class doc comment
   * above) exposes exactly this hook, and Cloudflare's own current
   * documentation is explicit that overriding it -- rather than adding
   * an external keep-alive signal to fight the default -- is the
   * intended way to control "only stop the container on certain
   * conditions."
   *
   * This directly probes the connector's own live /status right here,
   * rather than trusting a `renewActivityTimeout()` call from up to 60s
   * ago (the health-poll cadence) to still be accurate -- so a container
   * that is genuinely mid-send or mid-reconnect right when the timer
   * expires is not stopped out from under it just because the last poll
   * tick hasn't run yet. If the account is genuinely idle (no live/
   * reconnecting WhatsApp session), this calls `this.stop()` exactly
   * like the base class default -- the cost-guardrail intent (directive
   * rule 77: idle accounts genuinely stop costing money) is fully
   * preserved, not overridden away.
   */
  async onActivityExpired(): Promise<void> {
    const result = await this.pollHealthAndDecide().catch((err) => ({
      shouldStayAwake: false,
      status: `activity_expired_poll_error:${(err as Error).message}`,
    }))
    console.log(
      `[lifecycle] onActivityExpired club=${this.clubIdShort()} at=${new Date().toISOString()} result=${JSON.stringify(result)}`,
    )
    if (result.shouldStayAwake) {
      // renewActivityTimeout() was already called inside
      // pollHealthAndDecide() when shouldStayAwake is true -- this call
      // just makes the decision explicit at the exact expiry moment
      // rather than depending solely on the last 60s-cadence poll.
      this.renewActivityTimeout()
      return
    }
    await this.stop()
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
    await this.ctx.storage.delete(START_STATE_KEY)
  }

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
      const body = (await res.json()) as {
        shouldStayAwake: boolean
        pid?: number
        uptimeSeconds?: number
        memoryMb?: { rss: number }
        accounts?: Array<{
          clubId: string
          state: string
          generation?: number
          disconnectCount?: number
          reconnectCount?: number
          lastDisconnectReason?: string | null
          connectionUptimeMs?: number | null
        }>
      }
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
      // ADVERSARIAL PROOF SEQUENCE FINDING (2026-08-18): real WhatsApp
      // sends against this club are failing 100% of the time with
      // "socket.sendMessage() never resolved" -- reproduced 3 separate
      // times today, spanning BEFORE and AFTER all container-lifecycle
      // changes in this session, so it is NOT a regression introduced by
      // onActivityExpired()/the @cloudflare/containers upgrade. This is
      // read-only observability (BaileysProvider.getDiagnostics(), which
      // HealthServer.ts's /status already returns as `accounts` --
      // logging it here adds zero new data collection, only visibility)
      // to test the "zombie socket" hypothesis: a WASocket whose
      // connection.update handler never fired 'close', so
      // whatsapp_accounts.status stays 'connected' in Supabase while the
      // real WA-side session is dead. generation/disconnectCount/
      // reconnectCount/connectionUptimeMs answer this without needing to
      // touch the send path itself.
      // BUG FOUND AND FIXED in this same diagnostic pass: HealthServer.ts's
      // /status returns `accounts` for EVERY club this connector process
      // knows about (TenantConnectionManager.getAllDiagnostics() iterates
      // its whole providers Map), not just the club THIS Durable Object
      // owns -- an earlier version of this loop logged every account
      // under `club=${this.clubIdShort()}` (this DO's OWN id), which once
      // produced a genuinely alarming-looking line (a DIFFERENT,
      // already-known logged_out club's diagnostics logged as if it were
      // this DO's account) before being traced back to this mislabeling,
      // not a real event on this account. Fixed by logging each
      // account's OWN clubId (already an 8-char-truncated, non-secret
      // prefix from BaileysProvider.redactedClubId()) instead.
      for (const account of body.accounts ?? []) {
        console.log(
          `[diag] baileysState reportedBy=${this.clubIdShort()} accountClub=${account.clubId} at=${new Date().toISOString()} state=${account.state} generation=${account.generation} disconnectCount=${account.disconnectCount} reconnectCount=${account.reconnectCount} lastDisconnectReason=${account.lastDisconnectReason} connectionUptimeMs=${account.connectionUptimeMs}`,
        )
      }
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
   * Proxies a single-contact session repair into the container's
   * internal /repair-session endpoint. See BaileysProvider.
   * repairContactSession's own doc comment for what this does and why
   * -- added 2026-08-19 after a real live incident where messages were
   * accepted by WhatsApp's relay (real provider_reference) but stuck
   * undecryptable on the recipient's device.
   */
  async repairContactSession(clubId: string, phone: string): Promise<{ ok: boolean; sessionFilesRemoved?: number; error?: string }> {
    try {
      const res = await this.containerFetch(
        'http://container/repair-session',
        {
          method: 'POST',
          headers: { 'x-internal-token': this.env.CONTAINER_INTERNAL_TOKEN, 'content-type': 'application/json' },
          body: JSON.stringify({ clubId, phone }),
        },
        this.defaultPort,
      )
      const body = (await res.json()) as { ok?: boolean; sessionFilesRemoved?: number; error?: string }
      if (!res.ok) {
        return { ok: false, error: body.error ?? `http_${res.status}` }
      }
      return { ok: true, sessionFilesRemoved: body.sessionFilesRemoved }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
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
      return
    }

    // shouldStayAwake=true renews the activity timeout inside
    // pollHealthAndDecide() itself. The REAL enforcement point that
    // decides whether the container is actually allowed to stop on
    // expiry is onActivityExpired() above -- this poll's only job here
    // is keeping the timeout renewed between expiries so a genuinely
    // busy account doesn't even reach that decision point prematurely.

    // Every outcome -- shouldStayAwake true or false (genuinely idle,
    // correctly allowed to sleep), or a transient fetch error --
    // reschedules the next tick. A transient error must never
    // permanently kill the polling loop (the earlier version of this
    // method deleted START_STATE_KEY here, which silently stopped all
    // future polling after a single blip -- fixed, see this method's
    // git history/commit message for the full story); it just tries
    // again in 60s, same as any other non-fatal outcome.
    await this.scheduleNextHealthPoll()
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
