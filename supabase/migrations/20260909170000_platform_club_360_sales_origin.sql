-- PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Workstream 2, Tenant 360
-- integration.
--
-- CONFIRMED GAP (architecture inspection, 2026-09-09): PlatformClubDetailPage.tsx
-- (2064 lines) has zero references to "sales" or "lead" -- no sales-origin
-- context is shown anywhere on a converted club's detail page today,
-- despite sales_conversion_records and sales_leads.converted_club_id
-- being fully populated at conversion time (Phase 14,
-- 20260904120100_sales_tenant_activation_invites_rpcs.sql).
--
-- New, narrow, read-only RPC -- returns null (not an error, not a
-- fabricated row) for the ~13 fixture clubs and any real club that was
-- never a sales-sourced conversion, which is the large majority of
-- clubs today (self-service signup remains the primary path; sales
-- conversion is one specific acquisition channel, not the default).
-- Directive's own instruction: "do not duplicate data unnecessarily" --
-- this RPC returns only the lead's identity/business-name/source and
-- the conversion record's own summary fields, not the lead's full
-- profile (enrichment/scoring/outreach history) -- an operator who
-- wants that detail clicks through to the Sales Lead Detail page via
-- the returned lead_id, exactly the same "link out, don't duplicate"
-- pattern get_platform_attention_items() already established for
-- linking to Tenant 360 itself.
create or replace function public.get_platform_club_sales_origin(p_club_id uuid)
returns table(
  lead_id uuid,
  business_name text,
  source_place_id text,
  converted_at timestamptz,
  converted_by uuid,
  converted_by_name text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not (public.is_platform_owner() or public.has_platform_permission('platform.club.view')) then
    raise exception 'not authorized';
  end if;

  return query
    select
      sl.id as lead_id,
      sl.business_name,
      sl.source_place_id,
      scr.converted_at,
      scr.converted_by,
      p.full_name as converted_by_name
    from public.sales_conversion_records scr
    join public.sales_leads sl on sl.id = scr.lead_id
    left join public.profiles p on p.user_id = scr.converted_by
    where scr.club_id = p_club_id;
end;
$$;

revoke execute on function public.get_platform_club_sales_origin(uuid) from public, anon;
grant execute on function public.get_platform_club_sales_origin(uuid) to authenticated;

comment on function public.get_platform_club_sales_origin(uuid) is
  'Returns the originating sales lead for a club converted via Phase 14 tenant activation, or zero rows if the club was not sales-sourced (the common case -- self-service signup remains the primary path). Deliberately narrow (identity + conversion summary only, not the lead''s full enrichment/scoring/outreach history) -- an operator wanting that detail follows lead_id to the existing Sales Lead Detail page rather than this RPC duplicating it.';
