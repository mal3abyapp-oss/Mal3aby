-- Correction: Fawry's staging/sandbox ENVIRONMENT genuinely exists
-- (atfawry.fawrystaging.com) and is fully functional -- the real
-- constraint documented in PAYMENT_GATEWAY_PROVIDER_MATRIX.md is that
-- obtaining real sandbox CREDENTIALS requires manual merchant
-- registration/approval (~2 business days), not that sandbox itself
-- is unsupported. supports_sandbox=false would have been misleading;
-- the manual-onboarding lead-time is a club-connection-flow UX
-- concern (surfaced in the Club Owner UI copy), not a provider
-- capability flag.
update public.payment_gateway_providers set supports_sandbox = true where key = 'fawry';
