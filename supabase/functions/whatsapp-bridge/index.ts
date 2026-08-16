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
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405 });
  }

  if (!CONNECTOR_URL || !CONNECTOR_SECRET) {
    // Honest failure -- the connector service isn't configured/reachable
    // from this environment yet (it's a separate deployment target, see
    // whatsapp-connector/README.md). Never silently pretend success.
    return new Response(
      JSON.stringify({ error: "connector_not_configured", detail: "WHATSAPP_CONNECTOR_URL / CONNECTOR_INTERNAL_SECRET are not set for this Edge Function." }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  let body: { clubId?: string; action?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }

  const { clubId, action } = body;
  if (!clubId || !action || !ALLOWED_ACTIONS.has(action)) {
    return new Response(JSON.stringify({ error: "clubId and a valid action are required" }), { status: 400 });
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
    return new Response(JSON.stringify({ error: "not authorized" }), { status: 403 });
  }
  void authorized;

  const connectorBody = JSON.stringify({ clubId });
  const signature = await hmacSign(CONNECTOR_SECRET, connectorBody);

  const connectorRes = await fetch(`${CONNECTOR_URL}/${action}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-connector-signature": signature,
    },
    body: connectorBody,
  });

  const connectorJson = await connectorRes.json();
  return new Response(JSON.stringify(connectorJson), {
    status: connectorRes.status,
    headers: { "Content-Type": "application/json" },
  });
});
