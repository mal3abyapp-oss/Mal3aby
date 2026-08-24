-- SECURITY HYGIENE (LOW/INFORMATIONAL, from this audit's systemic
-- grant inventory sweep -- project gxkrtlvpjwxhcqdisyob). None of the
-- items below are independently exploitable (RLS/FORCE RLS already
-- gates every table correctly, and no direct application caller
-- reaches the affected function), but each is a real deviation from
-- this project's own least-privilege convention worth closing.
--
-- 1. payment_method_configs: table-level grants were asymmetric --
--    anon held INSERT/UPDATE/DELETE that authenticated lacked (the
--    opposite of every other table in this schema, where authenticated
--    holds broader raw grants than anon). RLS policy
--    payment_method_configs_write_with_permission already requires
--    has_permission('payment.methods.manage', club_id) -- which
--    resolves false for anon (no auth.uid()) -- so this was not
--    independently exploitable, but anon should never hold a raw
--    write grant it can never legitimately use.
--
-- 2. Three trigger functions (audit_messaging_safety_settings_change,
--    ensure_messaging_safety_settings, protect_subscription_price_
--    immutable) unnecessarily grant EXECUTE to anon. These are
--    RETURNS trigger functions, invoked only by Postgres internally on
--    DML against their owning tables -- never directly callable via
--    RPC regardless of this grant -- so it was functionally inert, but
--    removing it matches the "no unused surface" discipline already
--    applied elsewhere in this codebase.
--
-- 3. resolve_customer_notification_email: granted EXECUTE to
--    authenticated, but has no direct application caller (verified via
--    repo-wide grep -- only queue_email_notification(), a SECURITY
--    DEFINER function, calls it internally, which runs under the
--    definer's own elevated auth.users access regardless of this
--    grant). When called directly as `authenticated` it hard-errors
--    with "permission denied for table users" (authenticated has no
--    grant on auth.users) rather than leaking anything -- confirmed
--    live via an unrelated-club Coach account, no data disclosure
--    occurred. Narrowing the grant to service_role removes dead
--    surface without changing any real behavior.

revoke insert, update, delete on public.payment_method_configs from anon;

revoke all on function public.audit_messaging_safety_settings_change() from anon;
revoke all on function public.ensure_messaging_safety_settings() from anon;
revoke all on function public.protect_subscription_price_immutable() from anon;

revoke all on function public.resolve_customer_notification_email(uuid) from authenticated;
grant execute on function public.resolve_customer_notification_email(uuid) to service_role;
