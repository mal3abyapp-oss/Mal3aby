-- Payment hotfix: record_payment() supports ordinary payments without an
-- official receipt, but its untyped RECORD variable had no tuple descriptor
-- in that path. Later receipt metadata projection therefore raised
-- "record v_receipt is not assigned yet" even behind a false CASE branch.
-- Preserve the exact deployed function body and make the declaration typed.
do $migration$
declare
  v_oid oid;
  v_before text;
  v_after text;
begin
  select p.oid into v_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'record_payment'
    and pg_get_function_identity_arguments(p.oid) =
      'p_invoice_id uuid, p_amount numeric, p_method text, p_reference text, p_idempotency_key uuid, p_official_receipt_id uuid';

  if v_oid is null then
    raise exception 'expected six-argument public.record_payment function was not found';
  end if;

  v_before := pg_get_functiondef(v_oid);
  v_after := replace(
    v_before,
    'v_receipt record;',
    'v_receipt public.official_collection_receipts%rowtype;'
  );

  if v_after = v_before then
    raise exception 'record_payment receipt declaration did not match expected source';
  end if;

  execute v_after;
end;
$migration$;
