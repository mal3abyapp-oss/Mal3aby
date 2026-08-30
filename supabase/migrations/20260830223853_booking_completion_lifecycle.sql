-- FINAL BOOKINGS UX & LIFECYCLE GAP CLOSURE, Section B: booking
-- completion lifecycle. The `bookings.status` check constraint has
-- allowed 'completed' since phase 6, but no RPC and no scheduled job
-- has ever written it -- it has been a defined-but-unreachable
-- terminal state. This migration adds the two writers approved by the
-- project owner's directive:
--   (1) mark_booking_completed() -- manual staff action, only when
--       status in ('confirmed','checked_in') AND end_at has passed.
--   (2) auto_complete_past_bookings() -- scheduled job, ONLY
--       transitions checked_in -> completed once end_at has passed.
--       Deliberately does NOT touch 'confirmed' bookings that were
--       never checked in -- see the function's own comment for why.
--
-- Both reuse the exact permission/branch-scope/audit pattern already
-- established by mark_booking_no_show() (booking.update permission,
-- user_has_branch_access, write_audit_log) -- no new permission key
-- invented, matching the directive's explicit instruction.

-- completed_by/completed_at are a DEDICATED pair, distinct from the
-- existing marked_by/marked_at (which mark_booking_no_show already
-- owns) -- reusing marked_by/marked_at for completion would silently
-- overwrite a booking's no-show audit trail columns if it were ever
-- possible to reach both states, and would make it impossible to
-- tell "who/when no-showed this" apart from "who/when completed
-- this" by column alone.
alter table public.bookings
  add column if not exists completed_by uuid references auth.users(id),
  add column if not exists completed_at timestamptz,
  add column if not exists completion_source text
    check (completion_source in ('manual', 'automatic'));

comment on column public.bookings.completed_by is
  'Staff auth.uid() for a manual completion; NULL for an automatic (scheduled-job) completion -- see completion_source.';
comment on column public.bookings.completion_source is
  'manual = staff pressed "Mark completed"; automatic = the auto_complete_past_bookings() scheduled job transitioned a checked_in booking whose end_at had passed.';

-- ---------------------------------------------------------------
-- B3: manual completion RPC
-- ---------------------------------------------------------------
create or replace function public.mark_booking_completed(p_booking_id uuid, p_reason text default null)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_branch_id uuid;
  v_end_at timestamptz;
begin
  select club_id, branch_id, end_at into v_club_id, v_branch_id, v_end_at
  from public.bookings
  where id = p_booking_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('booking.update', club_id);

  if v_club_id is null then
    raise exception 'booking not found or you do not have permission to update it';
  end if;

  if not public.user_has_branch_access(v_club_id, v_branch_id) then
    raise exception 'not authorized for this branch';
  end if;

  -- Directive B3: do NOT allow manual completion before end_at, even
  -- if status is otherwise eligible (confirmed/checked_in) -- a
  -- booking cannot be "completed" while it hasn't finished yet.
  if v_end_at > now() then
    raise exception 'this booking has not ended yet -- it cannot be marked completed before its scheduled end time';
  end if;

  update public.bookings
  set status = 'completed',
      completed_by = auth.uid(),
      completed_at = now(),
      completion_source = 'manual',
      notes = case when p_reason is not null and p_reason <> ''
                then coalesce(notes || E'\n', '') || p_reason
                else notes end
  where id = p_booking_id and status in ('confirmed', 'checked_in');

  if not found then
    raise exception 'booking not found or not in a state that can be marked completed';
  end if;

  perform public.write_audit_log(
    v_club_id, 'mark_booking_completed', 'bookings', p_booking_id, null,
    jsonb_build_object('status', 'completed', 'completion_source', 'manual'), p_reason
  );
end;
$function$;

revoke all on function public.mark_booking_completed(uuid, text) from public;
grant execute on function public.mark_booking_completed(uuid, text) to authenticated;

-- ---------------------------------------------------------------
-- B2: automatic completion -- scheduled job
-- ---------------------------------------------------------------
-- Directive B2: ONLY checked_in -> completed once now() >= end_at.
-- Deliberately does NOT touch 'confirmed' bookings that were never
-- checked in -- a confirmed booking with no QR check-in could
-- represent real attendance without QR use, or a no-show staff
-- hasn't classified yet. Automatically completing it would destroy
-- that distinction and could hide an unclassified no-show as if it
-- were a normal completed visit. Staff can still manually complete a
-- 'confirmed' booking (see mark_booking_completed above) -- that is a
-- deliberate human judgment call this job does not make on its own.
--
-- Follows the exact structure of expire_stale_booking_holds()
-- (supabase/migrations/20260819170000_booking_payment_hold_expiry.sql):
-- bounded per-run batch (limit 200), one row at a time with a
-- status-guarded UPDATE (idempotent -- a row already transitioned by
-- a concurrent run or a manual completion simply fails the `where
-- status = 'checked_in'` guard and is silently skipped, `if found`
-- gates the audit write), one write_audit_log call per affected row.
create or replace function public.auto_complete_past_bookings()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_booking record;
  v_count integer := 0;
begin
  for v_booking in
    select id, club_id
    from public.bookings
    where status = 'checked_in'
      and end_at <= now()
    order by end_at
    limit 200
  loop
    update public.bookings
    set status = 'completed',
        completed_by = null,
        completed_at = now(),
        completion_source = 'automatic'
    where id = v_booking.id and status = 'checked_in';

    if found then
      v_count := v_count + 1;

      -- System/automation actor: write_audit_log records auth.uid(),
      -- which is NULL in this cron-job execution context (no JWT) --
      -- the same, already-established representation
      -- expire_stale_booking_holds() uses for its own automated
      -- writes. Never fabricate a human actor id here.
      perform public.write_audit_log(
        v_booking.club_id, 'booking.auto_completed', 'bookings', v_booking.id, null,
        jsonb_build_object('status', 'completed', 'completion_source', 'automatic'),
        'automatic completion (scheduled job): end_at has passed'
      );
    end if;
  end loop;

  return v_count;
end;
$function$;

revoke all on function public.auto_complete_past_bookings() from public;

-- Schedule: every 15 minutes, matching the directive's "bounded/safe
-- scheduled transition mechanism" guidance -- frequent enough that a
-- completed booking becomes visible in reports/Customer360 promptly,
-- not so frequent it competes unnecessarily with the existing
-- per-minute expire-stale-booking-holds job for cron slots.
select cron.schedule(
  'auto-complete-past-bookings',
  '*/15 * * * *',
  $$select public.auto_complete_past_bookings();$$
);
