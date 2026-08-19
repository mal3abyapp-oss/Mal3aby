-- One-time backfill decision (not a guessing rule for future clubs):
-- all 6 pre-existing clubs are confirmed Egyptian-market clubs (owner
-- locale, currency, existing phone data pattern). Setting country=EG
-- unblocks local-number entry for real operational use immediately.
-- This is NOT the pattern for new clubs going forward -- onboarding
-- asks the club to set/confirm country explicitly. Documented decision
-- per directive section 32/36/37; confirmed with the user before
-- applying (session record).
update public.clubs set country = 'EG' where country is null;
