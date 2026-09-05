-- OWNER DECISION (2026-09-05): the official Mal3aby free-trial duration
-- is 14 days, not 7. platform_settings.default_trial_days was live-
-- updated to 14 via public.update_platform_settings(14) (audited,
-- confirmed in audit_logs: before {default_trial_days: 7}, after
-- {default_trial_days: 14}). This migration additionally changes the
-- column's own schema-level default so any future direct insert into
-- platform_settings (there is only ever one singleton row, id=true,
-- but this closes the gap belt-and-suspenders) also starts at 14, not
-- the original 7 set in 20260815140000_phase3b_platform_billing.sql.
alter table public.platform_settings alter column default_trial_days set default 14;
