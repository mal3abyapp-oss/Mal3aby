-- P0 PRODUCTION-BREAKING FIX (2026-09-04): sales_claim_discovery_job()
-- has been throwing "column reference \"attempts\" is ambiguous"
-- (42702) on every single call since it was first written -- the SAME
-- defect class as sales_check_and_increment_quota() (daily_cap) and
-- complete_new_club_onboarding() (club_id), all fixed earlier. This
-- means real discovery jobs could be CREATED (sales_create_discovery_
-- job() has no such collision) but could never actually be CLAIMED and
-- processed -- every discovery run through the real production UI
-- (Sales Intelligence > Discover) got stuck at status='pending' forever.
--
-- Confirmed live during the Google Places provider acceptance test
-- (first real end-to-end discovery attempt against the newly-activated
-- provider): a real job was created via sales_create_discovery_job(),
-- but the Edge Function's claim step failed with 500 "could not claim a
-- discovery job to process", and direct reproduction via SQL surfaced
-- the exact 42702 root cause.
--
-- Root cause: this function's own `returns table(job_id uuid,
-- source_key text, search_params jsonb, next_page_token text, attempts
-- int)` clause implicitly declares `attempts` as a PL/pgSQL OUT
-- parameter in scope for the entire function body. The line:
--
--   update public.sales_discovery_jobs
--   set status = 'running', attempts = attempts + 1, ...
--
-- has `attempts = attempts + 1` inside embedded SQL, ambiguous between
-- the table column (sales_discovery_jobs.attempts) and the OUT
-- parameter of the same name.
--
-- Fix: add `#variable_conflict use_column` (same proven pattern as the
-- two prior fixes in this session) so plpgsql always prefers a table
-- column over a same-named OUT parameter when a bare identifier inside
-- embedded SQL is otherwise ambiguous. No other behavior change --
-- signature, return shape, and claim semantics (FOR UPDATE SKIP LOCKED,
-- oldest-first) are byte-identical to the previous (broken) version.

create or replace function public.sales_claim_discovery_job()
returns table(job_id uuid, source_key text, search_params jsonb, next_page_token text, attempts int)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
#variable_conflict use_column
declare
  v_job record;
begin
  select j.id, s.key, j.search_params, j.next_page_token, j.attempts
    into v_job
  from public.sales_discovery_jobs j
  join public.sales_lead_sources s on s.id = j.source_id
  where j.status in ('pending', 'retryable')
  order by j.created_at
  for update of j skip locked
  limit 1;

  if v_job.id is null then
    return;
  end if;

  update public.sales_discovery_jobs
  set status = 'running', attempts = attempts + 1, started_at = coalesce(started_at, now())
  where id = v_job.id;

  return query select v_job.id, v_job.key, v_job.search_params, v_job.next_page_token, v_job.attempts + 1;
end;
$$;

revoke all on function public.sales_claim_discovery_job() from public, anon, authenticated;
grant execute on function public.sales_claim_discovery_job() to service_role;
