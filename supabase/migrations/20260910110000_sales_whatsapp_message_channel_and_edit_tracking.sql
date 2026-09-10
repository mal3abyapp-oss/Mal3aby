-- OWNER DECISION #20, RESOLVED: "AI MAY generate a WhatsApp-ready sales
-- message. AI MUST NOT autonomously send it. The final send action
-- always requires explicit Platform Owner approval." Required workflow:
-- Lead -> Generate WhatsApp Draft -> Owner Review -> Owner Edit
-- (optional) -> Approve -> explicit Send -> Platform WhatsApp ->
-- delivery result/history/audit.
--
-- This migration is the schema layer. Two additive changes to the
-- EXISTING sales_outreach_messages table (no new table needed for the
-- draft itself -- it already has status/approved_by/approved_at/
-- sent_at/provider_reference/last_error, exactly the lifecycle
-- columns this workflow needs):
--
-- 1. NEW channel value 'whatsapp_message' -- structurally DISTINCT from
--    the pre-existing 'whatsapp_talking_points' (which generates a
--    multi-section human CALL SCRIPT -- opening/discovery/objection-
--    handling -- confirmed by reading its generation prompt in the
--    prior mission; never send-ready text, per the owner's explicit
--    instruction this migration implements: "Do not use
--    whatsapp_talking_points directly as the outbound message"). This
--    is a genuinely NEW artifact purpose, not a relaxation of the old
--    channel's semantics -- 'whatsapp_talking_points' keeps its exact
--    prior meaning and remains permanently un-sendable (still rejected
--    by sales_queue_outreach_message() for automated queueing, and now
--    also structurally ineligible for the new WhatsApp send path below,
--    which only accepts channel='whatsapp_message').
--
-- 2. Edit tracking: edited_body/edited_at/edited_by. The AI's original
--    output in `body` is NEVER overwritten (preserves the factual-
--    grounding audit trail exactly as before -- grounding jsonb still
--    describes what `body` was generated from). An owner edit writes to
--    the new edited_body column instead; the actually-sent text is
--    coalesce(edited_body, body) wherever a send matters, so "the owner-
--    edited approved draft sends the edited version" (an explicit
--    requirement) is a direct, structural consequence of that coalesce,
--    not a UI convention that could drift.
alter table public.sales_outreach_messages
  drop constraint if exists sales_outreach_messages_channel_check;

alter table public.sales_outreach_messages
  add constraint sales_outreach_messages_channel_check
  check (channel in ('email', 'phone_script', 'whatsapp_talking_points', 'whatsapp_message'));

alter table public.sales_outreach_messages
  add column if not exists edited_body text,
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by uuid references auth.users(id);

comment on column public.sales_outreach_messages.edited_body is
  'Owner-edited version of the AI-generated body, or null if never edited. body itself is NEVER modified after generation (preserves the grounding audit trail). The effective outbound text is always coalesce(edited_body, body).';
comment on column public.sales_outreach_messages.channel is
  'email | phone_script | whatsapp_talking_points (human call/chat script, never sent automatically) | whatsapp_message (NEW, owner decision #20 -- a single, literal, send-ready WhatsApp message, distinct from whatsapp_talking_points).';
