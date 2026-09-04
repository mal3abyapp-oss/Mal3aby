-- Sales Intelligence -- fix sales_claim_queued_outreach_message() (2026-09-04,
-- first-real-outreach pilot). Found live: the FIRST real production
-- invocation of this function (via the newly-authorized platform-owner
-- caller path added in the sales-outreach-email-sender auth fix) failed
-- with "record \"v_msg\" has no field \"message_id\"" -- a genuine,
-- pre-existing bug in this function's original definition
-- (20260904090400_sales_intelligence_scoring_outreach_conversion.sql)
-- that was never exercised until now, since nothing had successfully
-- reached the SEND step before this pilot.
--
-- ROOT CAUSE: `v_msg` is declared as a bare `record`, which takes on
-- whatever column names the populating SELECT gives it -- it has no
-- fixed field names of its own. The original SELECT list
-- (`m.id, m.lead_id, m.subject, m.body, l.public_email, m.language`)
-- populated a record with fields named `id`/`lead_id`/`subject`/
-- `body`/`public_email`/`language`, but the function body then
-- referenced `v_msg.message_id` and `v_msg.recipient_email` -- neither
-- of which exists on that record, causing an immediate runtime error
-- on the very first row this function ever tried to claim.
--
-- FIX: alias each column in the populating SELECT to match the exact
-- field names the function body already references. No other logic
-- changed -- same claim query, same FOR UPDATE SKIP LOCKED
-- concurrency-safe claim pattern, same returns table() shape, same
-- grants.
create or replace function public.sales_claim_queued_outreach_message()
returns table(message_id uuid, lead_id uuid, subject text, body text, recipient_email text, language text)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_msg record;
begin
  select m.id as message_id, m.lead_id as lead_id, m.subject as subject, m.body as body,
         l.public_email as recipient_email, m.language as language
    into v_msg
  from public.sales_outreach_messages m
  join public.sales_leads l on l.id = m.lead_id
  where m.status = 'queued' and m.channel = 'email' and l.status <> 'do_not_contact'
  order by m.created_at
  for update of m skip locked
  limit 1;

  if v_msg.message_id is null then
    return;
  end if;

  return query select v_msg.message_id, v_msg.lead_id, v_msg.subject, v_msg.body, v_msg.recipient_email, v_msg.language;
end;
$$;

revoke all on function public.sales_claim_queued_outreach_message() from public, anon, authenticated;
grant execute on function public.sales_claim_queued_outreach_message() to service_role;
