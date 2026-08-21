-- ROOT-CAUSE FIX (P1, confirmed live-active): the generation-fencing
-- mechanism (20260818190000) was designed on the stated assumption
-- "fencing only needs to order writes from ONE process's own
-- sequential state machine" -- an assumption that silently breaks the
-- very first time a process restarts (redeploy, crash, or a Cloudflare
-- Container scale-to-zero/cold-start cycle -- none of these require an
-- actual bug to occur; they are normal operational events for this
-- architecture). BaileysProvider's `generation`/`stateSeq` counters
-- (BaileysProvider.ts) are plain in-process instance fields, seeded
-- from nothing, always starting at 0. A fresh process can therefore
-- never reach a generation higher than whatever accumulated across
-- every PRIOR process's restarts, so once whatsapp_accounts.last_generation
-- exceeds whatever a fresh process starts at (which is always true
-- after enough restarts), EVERY future status write from EVERY future
-- process is permanently rejected as stale -- including a correct,
-- true 'logged_out' report.
--
-- Confirmed live during an independent audit: club
-- b9178c0f-00b5-4c71-abec-b8772ffb8682 reached last_generation=17
-- through normal restart accumulation. A real WhatsApp-side logout
-- then occurred (independent of this bug -- a logged-out session
-- always requires a fresh QR scan regardless of any code fix). The
-- connector correctly attempted to report status='logged_out' with its
-- own fresh generation=2 -- REJECTED as stale
-- (whatsapp_connection_events: status_write_rejected_stale,
-- attempted_generation=2, current_generation=17). Real messages queued
-- during this window correctly FAILED to send at the connector itself
-- (BaileysProvider.sendMessage()'s own "not connected" guard --
-- confirming this was a real, live outage, not a display-only
-- artifact) but whatsapp_accounts.status remained 'connected',
-- meaning: the UI showed a healthy connection that could not actually
-- send, and the session-credential-purge fix (20260821153000) never
-- fired either, since it only runs on a status write that successfully
-- reaches 'logged_out'.
--
-- FIX: generation is no longer a client-side (connector-side) counter
-- seeded from nothing. It is now allocated ATOMICALLY by the database
-- itself, via a new claim RPC the connector calls exactly once per
-- process lifetime (at startup, per club it manages), before it ever
-- reports a status transition. This closes the actual race the
-- original 20260818190000 fix was trying to prevent (an old, still-
-- alive process's writes losing to a newer one) while also correctly
-- letting every genuinely NEW process become the trusted current
-- writer -- the two failure modes the old design conflated.
--
-- No blind reset of last_generation/last_state_seq to 0 anywhere in
-- this migration -- that would reopen exactly the race the fencing
-- mechanism exists to prevent (a still-alive old process, or a writer
-- racing during a rolling replacement, could then win against a
-- genuinely newer one). The one currently-stuck production account is
-- recovered by the SAME atomic claim mechanism every other account
-- uses -- once the real running connector process (re)claims its own
-- generation through this RPC (see companion connector-code change,
-- deployed in the same commit), it will correctly receive
-- current_generation + 1 = 18, strictly newer than the stuck 17, and
-- its true 'logged_out' report will finally be accepted on its own
-- merits -- no manual counter correction needed or performed.

create or replace function public.whatsapp_connector_claim_generation(
  p_club_id uuid
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_new_generation integer;
begin
  -- Row-level lock for the duration of this transaction -- two
  -- concurrent claims for the SAME club_id (e.g. an old process still
  -- shutting down racing a brand-new one starting up, or two
  -- replicas briefly overlapping during a rolling deploy) are
  -- serialized by Postgres itself: the second caller blocks on
  -- `for update` until the first's transaction commits, then reads
  -- the FIRST caller's already-incremented value -- guaranteeing two
  -- concurrent claims can never receive the same generation, and that
  -- each successive claim is strictly greater than the last, with no
  -- read-then-write gap for a race to land in.
  insert into public.whatsapp_accounts (club_id, status, last_generation, last_state_seq)
  values (p_club_id, 'disconnected', 0, 0)
  on conflict (club_id) do nothing;

  select last_generation + 1
    into v_new_generation
  from public.whatsapp_accounts
  where club_id = p_club_id
  for update;

  update public.whatsapp_accounts
  set last_generation = v_new_generation,
      last_state_seq = 0,
      updated_at = now()
  where club_id = p_club_id;

  insert into public.whatsapp_connection_events (club_id, event, actor_id, detail)
  values (p_club_id, 'generation_claimed', null, jsonb_build_object('new_generation', v_new_generation));

  return v_new_generation;
end;
$function$;

revoke all on function public.whatsapp_connector_claim_generation(uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_connector_claim_generation(uuid) to service_role;

comment on function public.whatsapp_connector_claim_generation(uuid) is
  'Atomically allocates the next generation number for a club''s WhatsApp connection, via a row lock (for update) that serializes concurrent callers -- the second of two simultaneous claims always blocks until the first commits, then reads the already-incremented value, so two processes can never receive the same generation. Called exactly once per connector process lifetime, per club, at startup, BEFORE any status is reported. Replaces the old in-process generation counter (BaileysProvider.ts, private generation = 0) that silently reset to 0 on every restart and eventually caused a permanent status-write lockout once the database''s remembered generation grew past what any fresh process could ever reach on its own. See 20260821200000 for the full incident this fixes.';
