-- Phase E (E5): daily pg_cron sweep transitioning any active/pending
-- academy subscription whose end_date has passed into 'expired', so
-- renewal's own "must be terminal" gate and the DUE/EXPIRED display
-- status actually converge over time instead of a subscription sitting
-- in 'active' forever once its period has lapsed. Daily (not
-- per-minute like expire_stale_booking_holds -- that guards a live
-- 60-minute payment hold where minute-level precision matters; a
-- monthly subscription's expiry has no such urgency) at an off-peak,
-- non-round-number UTC time to avoid clustering with other jobs.

select cron.schedule('expire-due-academy-subscriptions', '17 3 * * *', $$select public.expire_due_academy_subscriptions();$$);
