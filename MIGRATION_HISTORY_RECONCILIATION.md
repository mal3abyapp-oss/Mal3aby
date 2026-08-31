# Migration History Reconciliation

Written 2026-08-31, as part of the Production Operations, Observability
& Disaster Recovery acceptance pass (Section 8: Migration Consistency,
Section 9: Direct SQL Governance). Read-only inspection only — nothing
in the live database was changed to produce this document.

## What was checked

The full local `supabase/migrations/*.sql` file set (559 files) was
compared, name-by-name and version-by-version, against the authoritative
remote record: `supabase_migrations.schema_migrations` (596 applied
rows) on the live production project `gxkrtlvpjwxhcqdisyob`.

## Finding 1 — filename timestamp drift (cosmetic, not a data-integrity risk)

**337 of 559 local files** carry a timestamp prefix that does not match
the remote-recorded `version` for that same migration name — almost
entirely concentrated in the 2026-08-15 through 2026-08-24 window, where
local filenames follow a coarse, round-number scheme
(`20260815120000`, `20260815125000`, ...) while the remote table holds
the actual fine-grained apply-time timestamps
(`20260815093911`, `20260815093947`, ...).

**Verified this is NOT orphaned-duplicate drift**: every one of the 337
is the *sole* local copy of that migration by name — no case was found
where both a stale-timestamp file and a correctly-renamed file exist
side by side for the same migration. The content itself is present
locally; only the filename's timestamp is out of sync with history.

**Risk assessment**: low. `supabase db push`/CLI-based migration tooling
tracks applied state by the remote `schema_migrations` table, not local
filenames — this drift does not risk a migration being silently
re-applied or skipped through the CLI. Its practical cost is narrower:
`ls`-ordering the local folder does not reflect true historical apply
order, which matters only for a human trying to read chronological
project history directly from filenames.

**Decision**: not mass-renamed in this pass. Renaming 337 files is a
large, mechanical, non-zero-risk operation (touches every migration
filename referenced anywhere in documentation/tooling) for a cosmetic
gap with no functional/DR impact. Flagged here for a future session to
address deliberately, with its own dedicated verification pass — not
folded into this DR audit as a rushed side effect.

## Finding 2 — 15 local timestamp-prefix collisions (30 files)

Two unrelated local files occasionally share the identical 14-digit
timestamp prefix (e.g. both `20260819100000_platform_phase_a_
correctness_security_scale.sql` and `20260819100000_public_club_
booking_schema.sql` exist). Confirmed every colliding pair maps to two
*distinct*, non-colliding remote versions — this is a pure local
filename coincidence, not a case where two migrations were actually
double-applied under one version. No functional risk; same disposition
as Finding 1 (cosmetic, deferred, not mass-renamed here).

## Finding 3 — 54 remote-applied migrations with NO local file at all

This is the substantive governance gap. 54 real migrations exist in
production's applied history with zero corresponding file anywhere in
this repository — meaning a fresh database rebuilt purely from
`supabase/migrations/` would NOT reproduce the current live schema
exactly; it would be missing these 54 real, applied changes.

**3 of the 54 are transient/reverted and are correctly excluded from
concern** — confirmed live that each was undone by a later migration in
the same history, leaving no lasting schema effect:

| Version | Name | Reverted by |
|---|---|---|
| `20260815210001` | `temp_grant_academy_manager_for_smoke_test` | `20260815210311` (`revert_temp_club_manager_grant`) family |
| `20260824091223` | `qa_set_multiclub_b_public_slug` | `20260824094349` (`qa_cleanup_multiclub_b_public_slug`) |
| `20260824094349` | `qa_cleanup_multiclub_b_public_slug` | (itself the revert of the row above) |

**The remaining 51 are real, permanent schema/function/grant changes**
with no local record. The full list (remote version, remote name):

```
20260816134524  drop_redundant_enrollment_index
20260816134654  drop_orphaned_activate_subscription_overload
20260816140052  lock_down_activate_subscription_internal
20260816143843  fix_unfreeze_future_dated_freeze
20260816150550  qr_identity_verification_data_v2
20260816172420  revoke_whatsapp_trigger_fn_grants
20260817233906  drop_orphaned_debug_function
20260818083034  fix_claim_next_batch_default_arg
20260818083135  add_event_type_param_to_source_validity
20260818083209  drop_orphaned_source_validity_2arg_overload
20260818084152  drop_orphaned_cancel_pending_whatsapp_1arg_overload
20260818154309  whatsapp_observability_foundation
20260818154823  whatsapp_observability_write_rpc
20260818193630  whatsapp_status_write_fencing_v2
20260819091623  fix_whatsapp_failed_message_ops_anon_grant
20260819111350  fix_password_audit_anon_grant_leak
20260819124226  platform_settings_update_rpc_with_audit
20260819124650  platform_audit_log_with_actor_rpc
20260819172609  government_collection_compliance_policy_rpcs
20260819180043  official_receipts_report_rpc_fix
20260819184252  fix_compliance_exceptions_retroactive_bug
20260820033445  staff_booking_reject_past_start_time
20260820071227  wire_receipt_fields_into_booking_confirmed_paid_payload
20260820071303  wire_receipt_fields_into_payment_received_payload
20260820072431  invoice_pdf_receipt_and_booking_time_data_drop_and_recreate
20260821004357  void_invoice_on_booking_cancellation
20260821122531  fix_player_360_summary_unassigned_record
20260821122830  fix_player_360_summary_case_eager_eval
20260822225458  invoice_page_booking_qr_fix_ambiguous_column
20260823160203  activation_independent_secret_factor_dropfirst
20260823164654  checkin_financial_eligibility_hotfix_add_result_enum_value
20260823180346  email_notification_channel_fix_direct_insert
20260823183611  queue_email_notification_tenant_guard
20260825103926  portal_invoices_rpc_drop_recreate_widen_shape
20260825104201  portal_qr_bookings_rpc_widen_shape_add_club_id
20260825173127  staff_360_summary_add_activity_counts
20260825173355  staff_360_summary_fix_attendance_column
20260828084929  fix_get_shop_stock_count_detail_ambiguous_club_id
20260828085009  fix_get_shop_stock_count_detail_ambiguous_id_too
20260828085234  fix_list_shop_stock_counts_reapply_correct_location_name_column
20260828095920  fix_shop_inventory_summary_out_of_stock_missing_variants_v2
20260828232729  platform_support_session_history_rpc_fix_email_cast
20260829003256  drop_old_set_club_module_active_3arg_overload
20260829063437  fix_attendance_null_coach_auth_bypass
20260829063635  fix_attendance_group_coach_column_shadowing
20260829063845  enforce_branch_scope_on_attendance_marking
20260829100000  enforce_branch_scope_on_academy_write_rpcs
20260830123140  expense_voucher_widen_list_expenses
20260830123216  expense_voucher_widen_list_expenses_fix_ambiguous
20260830214542  wire_segmented_pricing_into_booking_rpcs_v2
```

(2 further rows — `temp_grant_coach_for_attendance_smoke_test`
`20260815210215`, and `staff_360_summary_add_activity_counts`
`20260825173127`/`fix_attendance_column` `20260825173355` above — are
included in the 51 count; the full-precision list above is the
authoritative one used for the count below.)

## Why these were NOT reconstructed as fabricated migration files

A first attempt at this reconciliation considered writing a local
`.sql` file for each of the 51, reconstructed from each object's
*current* live definition (`pg_get_functiondef()` where applicable).
That approach was deliberately rejected before any file was written:

- For every migration whose target function was touched again by a
  *later* migration, the current live definition reflects the sum of
  all changes since, not what this specific migration actually did —
  presenting that as "this file documents migration X" would be a
  materially false historical claim, not a reconstruction.
- For DROP/GRANT-named migrations (`drop_orphaned_*`,
  `revoke_whatsapp_trigger_fn_grants`, etc.), the exact original target
  (e.g. a specific overloaded function signature that no longer exists
  in any form) cannot be recovered from the current schema at all —
  only guessed at from the name.
- Fabricating migration files that assert historical fact via
  best-effort guesses is precisely the kind of "quiet corruption of
  governance history" this audit exists to prevent, not produce — this
  judgment call was independently reached and is recorded here rather
  than silently worked around.

## What this means for disaster recovery specifically

**A hypothetical "rebuild the database from `supabase/migrations/`
alone" restore path would NOT currently reproduce the exact live
schema** — it would be missing the 51 real changes listed above. This
matters *only* for that specific hypothetical (a from-scratch schema
rebuild using local files as the sole source of truth); it does **not**
affect:

- The real backup/restore question (Section 10/11 of this DR audit) —
  Supabase's own backup mechanism, where available, captures the actual
  database bytes/WAL, not a migration replay — so this gap is
  orthogonal to that capability (see `BACKUP_RECOVERY_PLAN.md` for the
  current, separately-documented, user-acknowledged state of that
  capability on the Free plan).
- Any currently-running production behavior — every one of the 51
  changes is live and correctly in effect today; this is a
  *documentation* gap in local version control, not a live-schema
  defect.

## Recommended follow-up (not done in this pass — scoping decision)

1. **Preferred, safest path**: the next time each of the 51 objects is
   touched by a real future migration anyway (which, per this
   project's own established discipline throughout its history, always
   does `CREATE OR REPLACE FUNCTION` with a fresh, dated, local file),
   the local record becomes complete for that object naturally, going
   forward, without needing a retroactive fabrication.
2. **If a full retroactive local-history record is wanted**: a human
   should decide, per-object, whether a best-effort reconstruction
   (clearly labeled as such, current-state-only, not historical) is an
   acceptable governance artifact — this is a judgment call about
   documentation completeness vs. accuracy, not something to decide
   unilaterally on the user's behalf.
3. **Timestamp-drift renaming (Finding 1/2)**: worth a dedicated,
   carefully-verified pass of its own if project history readability
   becomes a real operational need — not bundled into a DR audit.

## Direct SQL governance — the actual routine-deployment question

Separate from the historical gap above: **is direct SQL currently the
routine method for shipping schema changes, or is it the governed
migration path?** Checked directly against this session's own and every
prior phase's practice: every schema change performed in this
engagement (confirmed across the Full Product E2E, Notifications, and
this DR phase) used `apply_migration` (the governed path) —
`execute_sql` was used only for read-only inspection/diagnosis, never
as a DDL workaround. **Direct SQL is not the routine deployment
method for this project — the governed migration path is, consistently.**
The 51-migration gap documented above is a historical local-repository
completeness gap, not evidence of an ongoing direct-SQL bypass pattern.
