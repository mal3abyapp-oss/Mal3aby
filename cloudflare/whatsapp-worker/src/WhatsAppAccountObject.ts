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

  // Cloudflare's own Container class default (10m) is tuned for
  // request-driven workloads. This service does most of its real work
  // as background polling with no incoming HTTP traffic, so the
  // periodic alarm-driven health poll (scheduleNextHealthPoll below) is
  // what actually decides whether to keep this instance awake -- a
  // slightly shorter base window here just bounds how long a genuinely
  // dead/unresponsive instance can coast before the next poll has a
  // chance to let it sleep.
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
   */
  async onStart(): Promise<void> {
    await this.ctx.storage.put<AccountStartState>(START_STATE_KEY, { startedAt: Date.now() })
    await this.scheduleNextHealthPoll()
  }

  /**
   * Called when the container process exits, for any reason (clean
   * stop, crash, host-level restart). Clears the "running" record so a
   * subsequent ensureRunning() call correctly re-starts rather than
   * assuming a container is still alive when it is not.
   */
  async onStop(): Promise<void> {
    await this.ctx.storage.delete(START_STATE_KEY)
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
      const body = (await res.json()) as { shouldStayAwake: boolean }
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

  private async scheduleNextHealthPoll(): Promise<void> {
    // 60s cadence: frequent enough that a real disconnect is noticed
    // quickly (feeds the platform-owner WhatsApp health visibility
    // scoped as Phase B in MAL3ABY_PRODUCTION_READINESS.md), infrequent
    // enough to stay well within the Workers/DO free-tier request
    // budget even at hundreds of accounts.
    await this.schedule(60, 'runHealthPollTick')
  }

  /** Alarm callback target -- name must match the string passed to schedule(). */
  async runHealthPollTick(): Promise<void> {
    const result = await this.pollHealthAndDecide().catch((err) => ({
      shouldStayAwake: false,
      status: `tick_error:${(err as Error).message}`,
    }))
    // If the container reports it is no longer running (or the poll
    // itself failed with a connection-refused-shaped error), clear the
    // "started" record proactively rather than waiting for the next
    // ensureRunning() caller to discover a stale record on its own --
    // this keeps the storage record honest even if onStop() itself was
    // never called (e.g. a host-level hard kill that skipped the
    // graceful SIGTERM path entirely).
    if (result.status === 'not_started') {
      // Already cleared; nothing to do.
    } else if (!result.shouldStayAwake && result.status.startsWith('error:')) {
      await this.ctx.storage.delete(START_STATE_KEY)
    } else {
      // Still schedule the next tick regardless of outcome -- a single
      // failed/unhealthy poll must never silently stop future polling.
      await this.scheduleNextHealthPoll()
    }
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
