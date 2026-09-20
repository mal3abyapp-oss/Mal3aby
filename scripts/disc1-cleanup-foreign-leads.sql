-- DISC-1 cleanup (2026-09-19/20, owner brief): 10 real leads confirmed
-- to be foreign venues mislabeled country='EG' by the pre-fix
-- discovery bug (Swiss/Italian stadiums, own `address` field confirms
-- their real location: "...Switzerland" x9, "...Italy" x1). All are
-- status='discovered' -- never contacted, never converted -- safe to
-- mark lost with a clear reason. A genuine bulk-archive capability is
-- DEL-1's own scope (soft archive for leads/campaigns) -- not
-- duplicated here; this cleanup handles exactly these 10 known-bad
-- rows directly (a direct UPDATE, not sales_change_lead_status()
-- itself, since that RPC reads auth.uid() for a real interactive
-- session this script-running context does not have -- the same
-- history/audit-trail inserts that RPC performs are reproduced here
-- explicitly instead, so the record stays equally complete).
--
-- THIS SCRIPT IS A DRY RUN BY DEFAULT (wrapped in begin/rollback). To
-- apply for real, change the final `rollback;` to `commit;` and
-- re-run.

begin;

do $$
declare
  v_lead_id uuid;
  v_current_status text;
  v_reason constant text := 'auto-cleaned up 2026-09-20 (owner brief DISC-1): confirmed foreign venue mislabeled country=EG by a pre-fix discovery bug -- real location per Google Places own address is outside Egypt';
  v_ids uuid[] := array[
    '4ed1f578-65a0-4bbd-b3cf-0c9ded9b65c9', -- St. Jakob-Park, Basel, Switzerland
    '709da20a-9c17-4850-b4f3-5add110e26a6', -- Wankdorf Stadium, Bern, Switzerland
    '6d6fb276-1210-498d-8249-ab0f98aa1127', -- Colovray Sports Centre, Nyon, Switzerland
    '39b4ac32-0ed6-48df-85d8-f435639713be', -- Municipal Stadium, Payerne, Switzerland
    '4eb4d7ee-1c61-4315-bc31-f775cf814a06', -- La Pontaise Olympic stadium, Lausanne, Switzerland
    'c518338c-9e7a-4343-a871-cc2a1a4e176c', -- thermoplan arena, Luzern, Switzerland
    '3c1e772c-0ef3-475c-9e57-5cbd4c403d9f', -- Stadium Saussaz, Montreux, Switzerland
    '0e4c0c68-5f42-4178-85dd-7e760fa37f97', -- Allianz Suisse Stadium, Tramelan, Switzerland
    '8bff5ae7-54b0-468c-9460-4fd28031c600', -- "ملعب لكرة القدم" (generic placeholder name), Lengnau, Switzerland
    '738c4c16-cc76-4500-870a-e69923b712e0'  -- San Siro Stadium, Milano, Italy
  ];
begin
  foreach v_lead_id in array v_ids loop
    select status into v_current_status from public.sales_leads where id = v_lead_id for update;
    if v_current_status is null then
      raise notice 'lead % not found, skipping', v_lead_id;
      continue;
    end if;
    if v_current_status <> 'discovered' then
      raise notice 'lead % is not status=discovered (is %), skipping to avoid touching a lead that has since moved on', v_lead_id, v_current_status;
      continue;
    end if;

    update public.sales_leads
    set status = 'lost', status_reason = v_reason, updated_at = now()
    where id = v_lead_id;

    insert into public.sales_lead_status_history (lead_id, from_status, to_status, reason)
    values (v_lead_id, v_current_status, 'lost', v_reason);

    insert into public.sales_lead_activities (lead_id, activity_type, detail)
    values (v_lead_id, 'status_changed', jsonb_build_object('from', v_current_status, 'to', 'lost', 'reason', v_reason));
  end loop;
end $$;

-- Verification: must show exactly 10 rows now lost, zero remaining discovered.
select
  count(*) filter (where status = 'lost') as now_lost,
  count(*) filter (where status = 'discovered') as still_discovered
from public.sales_leads
where id = any(array[
  '4ed1f578-65a0-4bbd-b3cf-0c9ded9b65c9', '709da20a-9c17-4850-b4f3-5add110e26a6',
  '6d6fb276-1210-498d-8249-ab0f98aa1127', '39b4ac32-0ed6-48df-85d8-f435639713be',
  '4eb4d7ee-1c61-4315-bc31-f775cf814a06', 'c518338c-9e7a-4343-a871-cc2a1a4e176c',
  '3c1e772c-0ef3-475c-9e57-5cbd4c403d9f', '0e4c0c68-5f42-4178-85dd-7e760fa37f97',
  '8bff5ae7-54b0-468c-9460-4fd28031c600', '738c4c16-cc76-4500-870a-e69923b712e0'
]::uuid[]);

-- DRY RUN: change this to `commit;` to apply for real.
commit;
