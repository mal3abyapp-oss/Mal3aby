# Mal3aby WhatsApp connector -- Cloudflare Containers production image.
#
# Runs the SAME source as the existing bare-Node/VPS deployment path
# (package.json's `build`/`start` scripts, unchanged) -- this Dockerfile
# containerizes the existing connector with the minimum change needed,
# per the architecture directive's explicit instruction not to rewrite
# the connector. Multi-stage build: full toolchain in the build stage,
# a minimal production-dependency-only runtime image for the final
# stage, matching this project's own emphasis on small images.
#
# linux/amd64: Cloudflare Containers currently run on amd64 Firecracker
# microVMs -- build with `docker build --platform linux/amd64` (or let
# `wrangler containers build` handle platform selection) if building on
# an arm64 dev machine (e.g. Apple Silicon).

# ---- Build stage ----
FROM node:22-slim AS build
WORKDIR /app

# Install ALL dependencies (incl. devDependencies -- tsc, tsx types)
# for the build step only; the runtime stage below re-installs
# production-only deps into a clean layer.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:22-slim AS runtime
WORKDIR /app

# Non-root user where practical (per directive rule 10). node:22-slim
# already ships a non-root `node` user/group (uid/gid 1000) -- reused
# rather than creating a new one.
RUN mkdir -p /app/.baileys-auth-tmp && chown -R node:node /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Bundled Noto Sans Arabic font (OFL-1.1, see assets/fonts/NOTICE.md)
# used by InvoicePdf.ts for Arabic-script invoice PDF generation --
# copied as static assets, not fetched at runtime from any external
# service.
COPY assets ./assets

USER node

# Baileys' local working auth-dir cache -- explicitly ephemeral, see
# SessionStore.ts. Not a Docker VOLUME: Cloudflare Containers' disk is
# ephemeral by platform design regardless (confirmed via Cloudflare's
# own Containers documentation, "All disk is ephemeral" -- a live
# session is restored from Postgres at process startup via
# restoreAllPersistedSessions(), never assumed to survive on disk
# between container instances). Declaring it as a VOLUME here would
# misleadingly imply a persistence guarantee this image does not (and
# should not) rely on.
ENV WHATSAPP_TEMP_AUTH_DIR=/app/.baileys-auth-tmp
ENV HEALTH_PORT=8080

# Cloudflare Containers' Container class (startAndWaitForPorts(), see
# WhatsAppAccountObject.ts) waits for THIS PORT to accept a TCP
# connection as its startup-readiness signal -- confirmed against the
# actual installed @cloudflare/containers package API surface
# (node_modules/@cloudflare/containers/dist/lib/container.d.ts).
# UPDATED 2026-08-18 (@cloudflare/containers upgraded 0.0.13 -> 0.3.7,
# see WhatsAppAccountObject.ts's class-level doc comment for the full
# root-cause story that motivated the upgrade): 0.3.7 DOES expose a real
# `pingEndpoint: string` property that 0.0.13 lacked -- WhatsAppAccountObject.ts
# does not currently set it (defaultPort's plain TCP-reachability check,
# used since before this upgrade, remains sufficient and is not being
# changed without evidence it needs to be -- directive rule: "no random
# upgrade beyond what's justified by real evidence"). HealthServer.ts's
# actual /health, /ready, /status paths remain real and are polled by
# WhatsAppAccountObject's own 60s alarm-driven pollHealthAndDecide()
# logic (a request the DO makes AFTER the container is already confirmed
# port-reachable), not by the Container base class's own startup gate.
# Exposed here for documentation/local `docker run -p` convenience;
# Cloudflare's own routing to this port is
# configured via `defaultPort` in the Worker/Durable Object, not by
# this EXPOSE directive.
EXPOSE 8080

# Graceful shutdown: index.ts already handles SIGTERM (calls
# disconnectAllGracefully() -- tells WhatsApp's servers each device
# socket is closing cleanly BEFORE the process exits, which is what
# actually prevents the conflict/replaced reconnect-storm this
# codebase hit and fixed once already, P1 2026-08-17). No custom
# ENTRYPOINT/tini wrapper needed: Node 22 forwards signals correctly to
# a directly-exec'd child when it is PID 1, and `node dist/index.js`
# run via CMD (exec form, not shell form) IS PID 1 here.
CMD ["node", "dist/index.js"]
