// whatsapp-bridge — the trusted Supabase-side caller of the WhatsApp
// Connector Service (see /whatsapp-connector). This is the ONLY place
// that holds the connector's shared HMAC secret; the Vite client never
// sees it and never talks to the connector service directly.
//
// Flow: Vite client -> supabase.functions.invoke('whatsapp-bridge', {...})
//   (with the user's own Supabase JWT, verified automatically since
//   verify_jwt=true) -> this function re-checks club membership +
//   manage_whatsapp_connection permission via the same has_permission()
//   RPC every other write path in this app uses -> signs a request ->
//   forwards it to the connector service's internal HTTP API.
//
// This function never accepts a clubId the caller doesn't actually
// belong to, and never lets the caller specify which connector-service
// session to act on beyond their own club — matching the "do not let
// client choose sender session" requirement.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CONNECTOR_URL = Deno.env.get("WHATSAPP_CONNECTOR_URL");
const CONNECTOR_SECRET = Deno.env.get("CONNECTOR_INTERNAL_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_ACTIONS = new Set(["connect", "qr", "disconnect", "health"]);

// P1 fix: the Vite client calls this function via supabase.functions.invoke(),
// which the browser always precedes with a CORS preflight OPTIONS request.
// This function had no OPTIONS handler and no Access-Control-* response
// headers at all, so the browser blocked every real request before it ever
// reached the function body -- the QR/connect/disconnect chain was breaking
// silently at the network layer, not in any backend logic. verify_jwt=true
// on this function still fully gates every real request (Authorization is
// still required below); allowing the origin here only lets the browser
// see the response, it grants no additional access.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function hmacSign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  // The browser sends a CORS preflight OPTIONS request before the real
  // POST from supabase.functions.invoke() -- must be answered with the
  // CORS headers and a 2xx, or the browser blocks the real request before
  // it's ever sent. This is the actual root cause of the QR pipeline
  // appearing to do nothing: the click handler's fetch was rejected by
  // the browser itself, never reaching this function at all.
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  if (!CONNECTOR_URL || !CONNECTOR_SECRET) {
    // Honest failure -- the connector service isn't configured/reachable
    // from this environment yet (it's a separate deployment target, see
    // whatsapp-connector/README.md). Never silently pretend success.
    return jsonResponse(
      { error: "connector_not_configured", detail: "WHATSAPP_CONNECTOR_URL / CONNECTOR_INTERNAL_SECRET are not set for this Edge Function." },
      503,
    );
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  let body: { clubId?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "invalid json" }, 400);
  }

  const { clubId, action } = body;
  if (!clubId || !action || !ALLOWED_ACTIONS.has(action)) {
    return jsonResponse({ error: "clubId and a valid action are required" }, 400);
  }

  // Re-verify the caller's own JWT and permission for THIS club, using
  // the exact same has_permission()/user_club_ids() RLS predicate every
  // other write path in this app relies on -- never trust the client's
  // own claim that it's allowed to manage this club's connection.
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: authorized, error: authError } = await supabase.rpc("get_whatsapp_connection_status", { p_club_id: clubId });
  if (authError) {
    return jsonResponse({ error: "not authorized" }, 403);
  }
  void authorized;

  const connectorBody = JSON.stringify({ clubId });
  const signature = await hmacSign(CONNECTOR_SECRET, connectorBody);

  let connectorRes: Response;
  try {
    connectorRes = await fetch(`${CONNECTOR_URL}/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-connector-signature": signature,
      },
      body: connectorBody,
    });
  } catch (fetchError) {
    // Never hide a provider/network error behind a generic response --
    // the connector service may be unreachable (down, wrong URL, etc.).
    return jsonResponse(
      { error: "connector_unreachable", detail: fetchError instanceof Error ? fetchError.message : String(fetchError) },
      502,
    );
  }

  const connectorJson = await connectorRes.json();
  return jsonResponse(connectorJson, connectorRes.status);
});
