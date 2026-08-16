-- Security advisor fix: validate_whatsapp_template_variables() is a
-- BEFORE INSERT/UPDATE trigger function on public.whatsapp_templates
-- (see 20260816330000_whatsapp_templates_automations.sql). It was
-- created without the revoke-from-public/anon/authenticated treatment
-- every other function in this codebase gets, which left it directly
-- callable via /rest/v1/rpc/validate_whatsapp_template_variables by
-- both anon and authenticated roles. Trigger functions never need
-- EXECUTE granted to client roles -- Postgres invokes them internally
-- regardless of grants -- so close that off here.
revoke execute on function public.validate_whatsapp_template_variables() from public;
revoke execute on function public.validate_whatsapp_template_variables() from anon;
revoke execute on function public.validate_whatsapp_template_variables() from authenticated;
