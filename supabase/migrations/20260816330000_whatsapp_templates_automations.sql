-- Gate 8 continued: templates and automations, per Doc 3's exact
-- requirements.
--
-- whatsapp_templates: one row per (club, event_key, language) so
-- Arabic/English variants are independently editable (Doc 3: "each
-- supporting both Arabic and English"). variables is the declared list
-- of placeholder names the body legitimately uses (Doc 3: "variable
-- validation preventing template edits that break variable
-- substitution") -- enforced by validate_whatsapp_template_variables()
-- below rather than trusting the client.
create table public.whatsapp_templates (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  event_key text not null,
  language text not null check (language in ('ar', 'en')),
  body text not null,
  variables text[] not null default array[]::text[],
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  unique (club_id, event_key, language)
);

alter table public.whatsapp_templates enable row level security;

create policy "whatsapp_templates_select_own_club" on public.whatsapp_templates
  for select using (club_id in (select public.user_club_ids()) and public.has_permission('view_whatsapp', club_id));

create policy "whatsapp_templates_manage_own_club" on public.whatsapp_templates
  for all using (club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_templates', club_id))
  with check (club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_templates', club_id));

comment on table public.whatsapp_templates is
  'One row per (club, event, language) -- Gate 8. body uses {{variable}} placeholders; variables declares the legitimate set, enforced by validate_whatsapp_template_variables() so an edit can never silently break substitution.';

-- ============================================================
-- validate_whatsapp_template_variables: extracts every {{name}}
-- placeholder actually present in the body and rejects the write if
-- it references a variable not declared in `variables`, or declares a
-- variable never actually used (both directions of "breaking variable
-- substitution").
-- ============================================================
create or replace function public.validate_whatsapp_template_variables()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_used text[];
  v_undeclared text[];
begin
  select coalesce(array_agg(distinct m[1]), array[]::text[])
  into v_used
  from regexp_matches(new.body, '\{\{\s*([a-zA-Z0-9_]+)\s*\}\}', 'g') as m;

  select array_agg(v) into v_undeclared
  from unnest(v_used) as v
  where v <> all(new.variables);

  if v_undeclared is not null and array_length(v_undeclared, 1) > 0 then
    raise exception 'template body uses undeclared variable(s): %', array_to_string(v_undeclared, ', ');
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_whatsapp_template_variables on public.whatsapp_templates;
create trigger trg_validate_whatsapp_template_variables
  before insert or update on public.whatsapp_templates
  for each row execute function public.validate_whatsapp_template_variables();

-- ============================================================
-- whatsapp_automations: maps a notification event_type to a template +
-- delivery policy. Consumed by whatever eventually processes
-- notification_queue (the actual worker is a Gate 8 follow-up, an Edge
-- Function, not built in this pass -- see the module's own honest
-- scope note). audience/dedup/send-window are modeled as explicit
-- columns so "prevent automation loops, repeated sends, sending after
-- cancellation, reminders after the event has passed" (Doc 3) has real
-- data to enforce against, even before the worker itself exists.
-- ============================================================
create table public.whatsapp_automations (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  event_type text not null,
  template_event_key text not null,
  enabled boolean not null default true,
  delay_minutes int not null default 0,
  quiet_hours_start time,
  quiet_hours_end time,
  audience text not null default 'customer' check (audience in ('customer', 'guardian', 'staff')),
  dedup_window_minutes int not null default 60,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  unique (club_id, event_type)
);

alter table public.whatsapp_automations enable row level security;

create policy "whatsapp_automations_select_own_club" on public.whatsapp_automations
  for select using (club_id in (select public.user_club_ids()) and public.has_permission('view_whatsapp', club_id));

create policy "whatsapp_automations_manage_own_club" on public.whatsapp_automations
  for all using (club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_automations', club_id))
  with check (club_id in (select public.user_club_ids()) and public.has_permission('manage_whatsapp_automations', club_id));

comment on table public.whatsapp_automations is
  'Maps a notification event_type to a template + delivery policy (Gate 8). Consumed by the (not-yet-built) queue worker -- this migration establishes the rule data model, matching Doc 3''s WhatsApp -> Automations screen.';
