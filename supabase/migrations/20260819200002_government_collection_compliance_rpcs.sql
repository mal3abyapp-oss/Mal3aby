-- Government / Ministry Collection Compliance -- RPCs (directive
-- sections 6, 15-21, 29-32, 34-35, 58-60, 68).

begin;

-- ============================================================
-- Policy resolution: field -> branch -> club, first non-null wins.
-- ============================================================
-- Directive section 6: branch/field INHERIT by default. A field-level
-- row only exists when someone explicitly overrode it; same for
-- branch. If no field/branch row exists, resolve to the club-level
-- row. If no club-level row exists at all, government compliance is
-- OFF (safe default -- a club that never touched this feature behaves
-- exactly as before, directive section 48).
create or replace function public.get_effective_government_policy(
  p_club_id uuid,
  p_branch_id uuid default null,
  p_field_id uuid default null
)
returns public.government_collection_policies
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_policy public.government_collection_policies;
begin
  if p_field_id is not null then
    select * into v_policy from public.government_collection_policies
    where field_id = p_field_id limit 1;
    if found then return v_policy; end if;
  end if;

  if p_branch_id is not null then
    select * into v_policy from public.government_collection_policies
    where branch_id = p_branch_id and field_id is null limit 1;
    if found then return v_policy; end if;
  end if;

  select * into v_policy from public.government_collection_policies
  where club_id = p_club_id and branch_id is null and field_id is null limit 1;
  if found then return v_policy; end if;

  -- No policy row anywhere in the chain: return a synthetic
  -- "disabled" row rather than null, so callers never need a
  -- separate null-check code path.
  v_policy.club_id := p_club_id;
  v_policy.branch_id := p_branch_id;
  v_policy.field_id := p_field_id;
  v_policy.enabled := false;
  v_policy.official_receipt_required := false;
  v_policy.required_payment_methods := array[]::text[];
  return v_policy;
end;
$function$;

revoke all on function public.get_effective_government_policy(uuid, uuid, uuid) from public;
revoke all on function public.get_effective_government_policy(uuid, uuid, uuid) from anon;
grant execute on function public.get_effective_government_policy(uuid, uuid, uuid) to authenticated;

-- ============================================================
-- Policy write: club/branch/field scope, audited, override-guarded.
-- ============================================================
-- Directive section 34/59/60: staff cannot silently disable compliance
-- or override a field to bypass a requirement. Enforced here by
-- requiring club.update (the same permission gating other club-level
-- settings, deliberately NOT payment.create -- a payment-recording
-- staff member should not also be able to turn off the rule they're
-- supposed to follow) AND requiring a reason whenever DISABLING an
-- already-enabled policy, or creating a branch/field override that
-- differs from what it would otherwise inherit.
create or replace function public.update_government_compliance_policy(
  p_club_id uuid,
  p_branch_id uuid,
  p_field_id uuid,
  p_enabled boolean,
  p_authority_type text,
  p_official_receipt_required boolean,
  p_required_payment_methods text[],
  p_receipt_book_enabled boolean,
  p_receipt_series_enabled boolean,
  p_receipt_date_required boolean,
  p_receipt_image_required boolean,
  p_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_existing public.government_collection_policies;
  v_is_scope_override boolean;
  v_is_disabling boolean;
  v_policy_id uuid;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('club.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_branch_id is null and p_field_id is not null then
    raise exception 'a field-level policy requires its branch_id';
  end if;

  -- Look up whatever row currently exists at this exact scope (may be
  -- none -- first-time setup).
  select * into v_existing from public.government_collection_policies
  where club_id = p_club_id
    and branch_id is not distinct from p_branch_id
    and field_id is not distinct from p_field_id;

  v_is_scope_override := (p_branch_id is not null or p_field_id is not null);
  v_is_disabling := (v_existing.enabled is true and p_enabled is false);

  -- Directive section 34/59/60: disabling an already-enabled policy,
  -- or setting up a branch/field-level override row at all, requires
  -- an explicit reason -- never a silent toggle.
  if (v_is_disabling or v_is_scope_override) and (p_reason is null or length(trim(p_reason)) = 0) then
    raise exception 'a reason is required to % government compliance policy',
      case when v_is_disabling then 'disable' else 'override' end;
  end if;

  insert into public.government_collection_policies (
    club_id, branch_id, field_id, enabled, authority_type,
    official_receipt_required, required_payment_methods,
    receipt_book_enabled, receipt_series_enabled,
    receipt_date_required, receipt_image_required,
    is_override, override_reason, created_by
  ) values (
    p_club_id, p_branch_id, p_field_id, p_enabled, p_authority_type,
    p_official_receipt_required, coalesce(p_required_payment_methods, array['cash']),
    p_receipt_book_enabled, p_receipt_series_enabled,
    p_receipt_date_required, p_receipt_image_required,
    v_is_scope_override, p_reason, auth.uid()
  )
  on conflict (club_id, branch_id, field_id) do update set
    enabled = excluded.enabled,
    authority_type = excluded.authority_type,
    official_receipt_required = excluded.official_receipt_required,
    required_payment_methods = excluded.required_payment_methods,
    receipt_book_enabled = excluded.receipt_book_enabled,
    receipt_series_enabled = excluded.receipt_series_enabled,
    receipt_date_required = excluded.receipt_date_required,
    receipt_image_required = excluded.receipt_image_required,
    override_reason = excluded.override_reason,
    updated_at = now()
  returning id into v_policy_id;

  -- Directive section 35/58: GOVERNMENT_COMPLIANCE_ENABLED/DISABLED/
  -- GOVERNMENT_POLICY_CHANGED, with before/after and reason on
  -- sensitive changes.
  perform public.write_audit_log(
    p_club_id,
    case
      when v_existing.id is null and p_enabled then 'government_compliance.enabled'
      when v_is_disabling then 'government_compliance.disabled'
      else 'government_compliance.policy_changed'
    end,
    'government_collection_policy', v_policy_id,
    to_jsonb(v_existing),
    jsonb_build_object(
      'enabled', p_enabled, 'authority_type', p_authority_type,
      'official_receipt_required', p_official_receipt_required,
      'required_payment_methods', p_required_payment_methods,
      'branch_id', p_branch_id, 'field_id', p_field_id
    ),
    p_reason
  );

  return v_policy_id;
end;
$function$;

revoke all on function public.update_government_compliance_policy(uuid, uuid, uuid, boolean, text, boolean, text[], boolean, boolean, boolean, boolean, text) from public;
revoke all on function public.update_government_compliance_policy(uuid, uuid, uuid, boolean, text, boolean, text[], boolean, boolean, boolean, boolean, text) from anon;
grant execute on function public.update_government_compliance_policy(uuid, uuid, uuid, boolean, text, boolean, text[], boolean, boolean, boolean, boolean, text) to authenticated;

commit;
