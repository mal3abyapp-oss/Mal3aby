-- Sales Intelligence -- multi-channel outreach readiness, Phase 4/13/14
-- (2026-09-04): response-classification taxonomy + automatic follow-up
-- cancellation, built as a dedicated event model rather than overloading
-- sales_leads.status directly, per this mission's own explicit
-- instruction ("preferably as a dedicated outreach-response/event model
-- rather than overloading lead lifecycle status" -- and this codebase's
-- established convention of a narrow status-history table alongside the
-- broader activity timeline, e.g. sales_lead_status_history next to
-- sales_lead_activities).
--
-- Also adds sales_email_webhook_config -- the ONE place the Resend
-- inbound-webhook signing secret is stored (as a vault reference only,
-- never the raw value, matching sales_provider_configs.secret_vault_id
-- and every other third-party secret in this codebase).

-- ============================================================
-- sales_outreach_events: append-only classified response events. One
-- row per inbound signal Mal3aby learns about an outreach message --
-- a delivery confirmation, a bounce, a complaint, or (once the
-- reply-path pipeline lands) an actual reply classified into the
-- taxonomy this mission requires:
--   NO_REPLY (implicit -- absence of a row, not stored),
--   POSITIVE_REPLY, NEGATIVE_REPLY, NOT_INTERESTED,
--   REQUESTED_INFORMATION, DEMO_REQUESTED, WRONG_CONTACT, BOUNCED,
--   DO_NOT_CONTACT.
-- Delivery-lifecycle events (DELIVERED/COMPLAINED/FAILED) are also
-- recorded here since they arrive on the SAME Resend webhook and the
-- SAME per-message audit trail is the right home for them, but they are
-- NOT part of the reply-classification taxonomy above (they never
-- trigger the reply-driven follow-up cancellation logic below).
-- ============================================================
create table public.sales_outreach_events (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.sales_outreach_messages(id) on delete cascade,
  lead_id uuid not null references public.sales_leads(id) on delete cascade,
  event_type text not null check (event_type in (
    -- delivery lifecycle (provider-reported, factual, not a reply)
    'delivered', 'delivery_delayed', 'bounced', 'complained', 'failed',
    -- reply classification taxonomy (this mission's Phase 13 requirement)
    'positive_reply', 'negative_reply', 'not_interested',
    'requested_information', 'demo_requested', 'wrong_contact',
    'do_not_contact'
  )),
  -- true only for the reply-classification rows above -- lets queries
  -- (and the follow-up-cancellation trigger) select "did this lead
  -- reply" without re-enumerating the taxonomy list in every caller.
  is_reply boolean not null default false,
  -- Raw provider payload this classification was derived from (Resend
  -- webhook body, or a manually-entered reply where a human classifies
  -- a reply Mal3aby cannot ingest programmatically) -- kept for audit,
  -- same "grounding" discipline as sales_outreach_messages.grounding.
  raw_payload jsonb not null default '{}'::jsonb,
  -- Free-text excerpt/summary of the actual reply content, where
  -- available -- shown in the Sales UI so a human never has to guess
  -- why a classification was made. Never required (a delivery event has
  -- none).
  reply_excerpt text,
  -- 'system' for anything classified by the webhook handler itself
  -- (delivery/bounce/complaint events are unambiguous; Resend does not
  -- classify REPLY CONTENT for us -- see the webhook handler's own
  -- comment on why reply classification defaults to a human review
  -- queue rather than automated sentiment/intent inference), or the
  -- auth.uid() of the platform staff member who classified an inbound
  -- reply by hand.
  classified_by uuid references auth.users(id),
  provider_event_id text,  -- Resend's own event id, for idempotent dedup
  created_at timestamptz not null default now()
);

create index sales_outreach_events_message_idx on public.sales_outreach_events (message_id, created_at desc);
create index sales_outreach_events_lead_idx on public.sales_outreach_events (lead_id, created_at desc);
-- Idempotent webhook processing -- a redelivered Resend event (at-least-once
-- delivery, same discipline as every other webhook in this codebase)
-- converges on the same row instead of duplicating.
create unique index sales_outreach_events_provider_event_unique
  on public.sales_outreach_events (provider_event_id) where provider_event_id is not null;

alter table public.sales_outreach_events enable row level security;
alter table public.sales_outreach_events force row level security;

create policy sales_outreach_events_select on public.sales_outreach_events
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));

revoke all on table public.sales_outreach_events from anon, public;
-- No insert/update/delete policy for authenticated -- every write goes
-- through the RPCs below (service_role for the webhook path,
-- authenticated+permission-gated for the manual-classification path),
-- matching this module's "no direct table writes from the client"
-- convention throughout.

-- ============================================================
-- sales_email_webhook_config: stores the Resend inbound-webhook signing
-- secret as a vault reference. Single-row table (one Resend webhook
-- subscription for this whole platform, matching Resend's own
-- one-webhook-per-account-covers-all-domains model) rather than a new
-- provider_key on sales_provider_configs, since a webhook signing
-- secret is a materially different kind of credential (verifies INBOUND
-- requests, never used to make an outbound call) from the
-- API-key-shaped secrets that table already holds.
-- ============================================================
create table public.sales_email_webhook_config (
  id boolean primary key default true check (id),  -- enforces exactly one row, same singleton-table idiom used elsewhere in this codebase
  webhook_id text,               -- Resend's own webhook id (list-webhooks/get-webhook), for operator reference only
  secret_vault_id uuid,          -- references a vault.secrets row holding the whsec_... signing secret; NULL until configured
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

insert into public.sales_email_webhook_config (id) values (true);

alter table public.sales_email_webhook_config enable row level security;
alter table public.sales_email_webhook_config force row level security;

create policy sales_email_webhook_config_select on public.sales_email_webhook_config
  for select using (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'));

revoke all on table public.sales_email_webhook_config from anon, public;

create or replace function public.set_sales_email_webhook_secret(p_webhook_id text, p_secret_vault_id uuid, p_enabled boolean default true)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.sales.manage_settings')) then
    raise exception 'not authorized';
  end if;

  update public.sales_email_webhook_config
  set webhook_id = p_webhook_id, secret_vault_id = p_secret_vault_id, enabled = p_enabled, updated_at = now(), updated_by = auth.uid()
  where id = true;

  perform public.write_audit_log(null, 'sales.email_webhook.configure', 'sales_email_webhook_config', null, null,
    jsonb_build_object('webhook_id', p_webhook_id, 'enabled', p_enabled), 'Sales Intelligence inbound email webhook configured');
end;
$$;

revoke all on function public.set_sales_email_webhook_secret(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_sales_email_webhook_secret(text, uuid, boolean) to service_role;
-- service_role-only (not authenticated, unlike set_sales_provider_secret):
-- this is set programmatically by this session's own MCP-driven
-- create-webhook + vault.create_secret flow, never through a
-- human-facing Settings form -- keeping it service_role-only avoids
-- exposing a raw-secret-acceptance path in the frontend for a
-- signing secret that must never leave server-side storage.

-- ============================================================
-- sales_record_outreach_event(): the ONLY way sales_outreach_events
-- rows are created. Handles both paths:
--   service_role (auth.uid() is null): the resend-webhook Edge
--     Function, for delivery/bounce/complaint events it can classify
--     unambiguously from the Resend event type alone.
--   authenticated + platform.sales.edit: a human platform-staff member
--     manually classifying an inbound reply (Resend delivers the RAW
--     EMAIL CONTENT via email.received, but this mission does not
--     implement automated NLP intent classification of free-text reply
--     bodies -- see the resend-webhook function's own header for why
--     that is a deliberate, reported scope boundary, not an oversight).
-- ============================================================
create or replace function public.sales_record_outreach_event(
  p_message_id uuid,
  p_event_type text,
  p_raw_payload jsonb default '{}'::jsonb,
  p_reply_excerpt text default null,
  p_provider_event_id text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_lead_id uuid;
  v_event_id uuid;
  v_is_reply boolean;
begin
  if not (
    auth.uid() is null  -- service_role caller: resend-webhook, already independently signature-verified before this call
    or public.is_platform_owner()
    or public.has_platform_permission('platform.sales.edit')
  ) then
    raise exception 'not authorized';
  end if;

  select lead_id into v_lead_id from public.sales_outreach_messages where id = p_message_id;
  if v_lead_id is null then
    raise exception 'outreach message not found';
  end if;

  v_is_reply := p_event_type in (
    'positive_reply', 'negative_reply', 'not_interested',
    'requested_information', 'demo_requested', 'wrong_contact', 'do_not_contact'
  );

  insert into public.sales_outreach_events (
    message_id, lead_id, event_type, is_reply, raw_payload, reply_excerpt, classified_by, provider_event_id
  )
  values (
    p_message_id, v_lead_id, p_event_type, v_is_reply, p_raw_payload, p_reply_excerpt,
    case when auth.uid() is not null then auth.uid() else null end,
    p_provider_event_id
  )
  returning id into v_event_id;

  insert into public.sales_lead_activities (lead_id, activity_type, detail, actor_id)
  values (v_lead_id, 'outreach_event', jsonb_build_object('event_id', v_event_id, 'event_type', p_event_type, 'message_id', p_message_id), auth.uid());

  -- ------------------------------------------------------------
  -- Phase 14: automatic follow-up cancellation on reply / do_not_contact.
  -- Any genuine reply (the taxonomy above) means a human already has
  -- the prospect's attention -- a previously scheduled "follow up if no
  -- response" task is now stale and must not fire; cancel every PENDING
  -- follow-up for this lead, recording why. do_not_contact additionally
  -- flips the lead's own status so no future outreach step (generate/
  -- approve/queue -- all three already guard on this) can proceed.
  -- ------------------------------------------------------------
  if v_is_reply then
    update public.sales_followups
    set status = 'cancelled', last_action = format('auto-cancelled: lead replied (%s)', p_event_type), completed_at = now()
    where lead_id = v_lead_id and status = 'pending';

    if p_event_type = 'do_not_contact' then
      update public.sales_leads
      set status = 'do_not_contact', status_reason = 'inbound reply requested no further contact', updated_at = now()
      where id = v_lead_id and status <> 'do_not_contact';

      insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason)
      select v_lead_id, sales_leads.status, 'do_not_contact', 'inbound reply requested no further contact'
      from public.sales_leads where id = v_lead_id and status = 'do_not_contact'
        and not exists (
          select 1 from public.sales_lead_status_history
          where lead_id = v_lead_id and to_status = 'do_not_contact' and reason = 'inbound reply requested no further contact'
        );
    elsif p_event_type in ('positive_reply', 'demo_requested', 'requested_information', 'negative_reply', 'not_interested') then
      -- Advance pipeline status to 'replied' -- but never regress a
      -- lead that has already moved further down the pipeline (e.g. a
      -- late-arriving webhook delivery after a human already advanced
      -- the lead to demo_scheduled/negotiation/won/lost), and never
      -- touch a do_not_contact/won/lost terminal lead.
      update public.sales_leads
      set status = 'replied', updated_at = now()
      where id = v_lead_id and status in ('contacted', 'contact_ready', 'qualified', 'enriched');

      insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason)
      select v_lead_id, 'contacted', 'replied', format('inbound reply classified as %s', p_event_type)
      from public.sales_leads where id = v_lead_id and status = 'replied';
    end if;
  end if;

  return v_event_id;
end;
$$;

revoke all on function public.sales_record_outreach_event(uuid, text, jsonb, text, text) from public, anon;
grant execute on function public.sales_record_outreach_event(uuid, text, jsonb, text, text) to authenticated, service_role;

-- ============================================================
-- get_lead_outreach_events(): read RPC for the Sales UI (Phase 17) --
-- per-lead event timeline, newest first, joined with the parent
-- message's channel/subject for display context.
-- ============================================================
create or replace function public.get_lead_outreach_events(p_lead_id uuid)
returns table(
  id uuid, message_id uuid, event_type text, is_reply boolean,
  reply_excerpt text, created_at timestamptz,
  message_channel text, message_subject text
)
language sql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select e.id, e.message_id, e.event_type, e.is_reply, e.reply_excerpt, e.created_at,
         m.channel, m.subject
  from public.sales_outreach_events e
  join public.sales_outreach_messages m on m.id = e.message_id
  where e.lead_id = p_lead_id
    and (public.is_platform_owner() or public.has_platform_permission('platform.sales.view'))
  order by e.created_at desc
$$;

revoke all on function public.get_lead_outreach_events(uuid) from public, anon;
grant execute on function public.get_lead_outreach_events(uuid) to authenticated;
