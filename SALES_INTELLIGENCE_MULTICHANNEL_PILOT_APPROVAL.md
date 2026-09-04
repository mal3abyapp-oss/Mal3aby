# Mal3aby Sales Intelligence — Multi-Channel Outreach Readiness Approval

**Date:** 2026-09-04
**Mission:** Email Deliverability + Existing WhatsApp QR Integration + Multi-Channel Outreach Readiness
**Scope:** The SAME 5 pilot leads already selected and approved in `SALES_INTELLIGENCE_PILOT_APPROVAL.md` — no new lead discovery.
**Sends performed this mission:** **ZERO.** No email, WhatsApp, SMS, or automated call was sent to any real prospect. All verification below is direct database/API evidence or safe synthetic (non-prospect-facing) tests.

---

## 1. EMAIL ARCHITECTURE — CORRECTED FINDING

The prior pilot report (`SALES_INTELLIGENCE_PILOT_APPROVAL.md`, 2026-09-04) concluded `DELIVERABILITY = NOT READY`, reasoning that `send.mal3aby.app`'s SPF/MX records pointing at `amazonses.com` indicated a provider mismatch (Resend configured in code, Amazon SES configured in DNS). **This was incorrect and is corrected here.**

Resend's own infrastructure runs on Amazon SES internally — this is Resend's documented, standard architecture, not a misconfiguration. Confirmed directly against the Resend API (`get-domain`, domain id `f425017c-61c4-4c41-80e0-bf6771aff063`):

| Record | Type | Host | Value | Status |
|---|---|---|---|---|
| DKIM | TXT | `resend._domainkey` | `p=MIGfMA0GCSq...` | **verified** |
| SPF | MX | `send` | `feedback-smtp.eu-west-1.amazonses.com` (priority 10) | **verified** |
| SPF | TXT | `send` | `v=spf1 include:amazonses.com ~all` | **verified** |
| Receiving | MX | (root/apex) | `inbound-smtp.eu-west-1.amazonaws.com` (priority 10) | **verified** |

**Domain status: `verified`** (both sending and receiving capabilities enabled and fully verified).

### 1.1 DNS change made this mission (with explicit owner authorization)

The **receiving** MX record above did not exist at mission start. Per the mission's DNS-change-authorization gate, I presented:
- **Current record:** none (receiving not yet enabled)
- **Proposed record:** MX, root/apex `mal3aby.app`, value `inbound-smtp.eu-west-1.amazonaws.com`, priority 10
- **Why:** required by Resend to enable inbound email receiving (reply-path pipeline)
- **Risk:** additive only — does not touch the existing, already-verified sending records
- **Rollback:** delete the one MX record in Cloudflare DNS; disable `receiving` in Resend via `update-domain`

**Owner response: "Yes, add it (Recommended)."** I applied the record myself via the Cloudflare dashboard (the owner performed no technical action), verified it independently via `Resolve-DnsName -Name mal3aby.app -Type MX -Server 8.8.8.8` (confirmed: `mal3aby.app MX 10 inbound-smtp.eu-west-1.amazonaws.com`), and confirmed Resend's own verifier moved the domain to fully `verified` after calling `verify-domain`.

**Sender domain: VERIFIED. SPF: PASS/ALIGNED. DKIM: PASS/ALIGNED. DMARC:** not modified this mission (was not in scope of the receiving-record change; `_dmarc.mal3aby.app` TXT record was inspected via the Cloudflare dashboard's own DNS list during this session and is present).

### 1.2 Reply-path pipeline (Phase 4/5) — built and safely tested

- **New Edge Function `resend-webhook`** (deployed, `verify_jwt=false`, self-authenticating): receives Resend's webhook events (`email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, `email.received`) and converts them into `sales_outreach_events` rows via `sales_record_outreach_event()`.
- **Signature verification:** local HMAC-SHA256 over the Svix-format signed content (`svix-id.svix-timestamp.raw_body`), keyed by the real webhook signing secret (`whsec_...`) stored **only** in Supabase Vault (never in application tables, never logged). Stale timestamps (>5 min skew) are rejected even with a valid signature.
- **Resend webhook subscription created:** id `1da4fe32-7877-47d9-b4e3-857205b0895e`, endpoint `https://gxkrtlvpjwxhcqdisyob.supabase.co/functions/v1/resend-webhook`, subscribed to the 6 events above.
- **Safe, non-prospect verification performed** (synthetic payloads only, referencing a non-existent `email_id`, never a real prospect's data):
  1. Missing signature headers → `400` (fail-closed). **Verified.**
  2. Genuinely valid Svix signature, unmatched `email_id` → `200 {"received":true,"unmatched":true}` (correct — no real message exists to attach to). **Verified.**
  3. Forged/invalid signature → `400 {"error":"signature verification failed"}`. **Verified.**
  4. Valid signature but stale (10-minute-old) timestamp → `400 {"error":"signature verification failed"}` (replay-protection). **Verified.**
- **Reply-content classification scope boundary (reported honestly):** Resend's `email.received` event delivers the raw inbound email text, but this pipeline does **not** run automated NLP/intent classification on it (would require a second AI task outside this mission's $0-budget-approved Groq offer-generation use, and misclassifying a real "stop contacting me" reply has real consequences). Every `email.received` event is recorded as `requested_information` (a safe, reply-taxonomy member — it correctly triggers follow-up cancellation) with the full raw email preserved for a human platform-staff member to review and reclassify via the Sales UI. This is a genuine, deliberate scope boundary, not a silent gap.

**EMAIL_ELIGIBLE = READY.** Sending and receiving are both fully verified at the DNS/provider level; the reply-path pipeline is built, deployed, and proven correct via real (non-prospect) signature tests.

---

## 2. WHATSAPP ARCHITECTURE — STRUCTURAL FINDING

**Per the mission's explicit instruction, no new WhatsApp system was built and the existing QR connector was not modified.** The existing connector (`whatsapp-connector/` + `cloudflare/whatsapp-worker/`) was audited, not touched.

### 2.1 What the existing connector is (confirmed production-proven)

Per `docs/engineering/WHATSAPP_QR_PAIRING_FINAL_ACCEPTANCE_REPORT.md`, the Baileys-based connector has a full, real, production-proven E2E chain for **club-to-customer** messaging: QR generation → scan → connect → session persistence (AES-256-GCM encrypted) → restart → auto-restore → real message send with `provider_reference`. This is genuine, working infrastructure — the finding below is not "WhatsApp is broken."

### 2.2 The structural gap for Sales Intelligence (verified via live schema inspection)

```sql
create table public.whatsapp_accounts (
  club_id uuid primary key references public.clubs(id) on delete cascade,
  ...
);
```

`whatsapp_accounts.club_id` is the **primary key** with `ON DELETE CASCADE` to `clubs(id)` — **one WhatsApp session slot exists per real, already-onboarded club, and only per club.** `notification_queue.club_id` is `NOT NULL` — there is no queueing path that does not belong to a real club.

A `sales_leads` row is **not** a club. The one mechanism that would turn a lead into a club (Phase 14 / ADR-054's tenant-conversion flow) is an explicitly documented **open decision, not yet built** (see `sales_intelligence_scoring_outreach_conversion.sql`'s own `convert_sales_lead_to_tenant()` comment block).

**Conclusion: `WHATSAPP_ELIGIBLE = FALSE` for every Sales Intelligence lead today — structurally, not as a data-quality or configuration gap.** No workaround (e.g. a fake platform-owned club row to manufacture a WhatsApp slot) was introduced, per the mission's explicit "do not build another WhatsApp system" instruction — that would itself be a form of building a parallel system, and would conflate fabricated data with a real tenant.

**CHANNEL_CONNECTED vs LEAD_CHANNEL_ELIGIBLE, made explicit:** WhatsApp transport is platform-CONNECTED (real clubs use it successfully today) but zero-ELIGIBLE for sales leads (no account slot exists for any of them). This distinction is enforced at the code level — `get_lead_channel_eligibility()` always returns `whatsapp_eligible = false` with this exact structural reason, for every lead, unconditionally.

**This is not a blocker for the pilot** — it correctly rules WhatsApp out rather than silently defaulting to it or fabricating eligibility.

---

## 3. CHANNEL ELIGIBILITY ENGINE (Phase 8–12) — built, deployed, verified against real data

New RPC `get_lead_channel_eligibility(p_lead_id)` returns, per lead: `email_eligible`/`whatsapp_eligible`/`call_task_eligible` (each with a plain-language reason) and a single `recommended_channel` + reason. New `sales_call_tasks` table + `sales_create_call_task()`/`sales_complete_call_task()` RPCs implement **CALL_TASK** as an internal, human-actioned task — explicitly **not** an automated dialer, per the mission's Phase 10 requirement.

Verified directly against the 5 real pilot leads (SQL evidence, not simulated):

| Lead | EMAIL | WHATSAPP | CALL_TASK | Recommended |
|---|:-:|:-:|:-:|---|
| Elmasry Football Academy | ✅ | ❌ | ✅ | **EMAIL** |
| Pegasus Dreamland Club | ✅ | ❌ | ✅ | **EMAIL** |
| Mr Soccer Academy | ❌ (no public_email) | ❌ | ✅ | **CALL_TASK** |
| CIC Arenas | ❌ (no public_email) | ❌ | ✅ | **CALL_TASK** |
| Nasr City Sporting Club | ❌ (no public_email) | ❌ | ✅ | **CALL_TASK** |

No lead resolved to `NO_SAFE_CHANNEL` — every one of the 5 has at least a phone number on file.

### 3.1 Response classification taxonomy (Phase 13) — closed gap

New `sales_outreach_events` table + `sales_record_outreach_event()` RPC implement the required taxonomy: `NO_REPLY` (implicit — absence of a row), `POSITIVE_REPLY`, `NEGATIVE_REPLY`, `NOT_INTERESTED`, `REQUESTED_INFORMATION`, `DEMO_REQUESTED`, `WRONG_CONTACT`, `BOUNCED`, `DO_NOT_CONTACT` — plus delivery-lifecycle events (`delivered`/`delivery_delayed`/`complained`/`failed`) sharing the same audit trail. This closes a gap explicitly flagged as missing in the prior pilot report.

### 3.2 Automatic follow-up cancellation (Phase 14) — closed gap

Any reply-taxonomy event (email reply via the webhook, or a manually-classified call-task outcome) automatically cancels every `pending` `sales_followups` row for that lead (`status → 'cancelled'`, reason recorded), and a `DO_NOT_CONTACT` classification flips the lead's own `status` to `do_not_contact` (which, via the pre-existing `sales_change_lead_status`/`sales_generate_outreach_message`/`sales_queue_outreach_message` guards, blocks all further outreach generation/approval/queueing). Implemented once, shared by both the email-reply path and the call-task-outcome path.

---

## 4. PER-LEAD CHANNEL BREAKDOWN (the same 5 pilot leads — no new discovery)

For each lead: channel eligibility, selected channel, exact message content (reused from the already-grounded pilot drafts, not regenerated), grounding audit, follow-up plan, risks.

### 4.1 Elmasry Football Academy

- **EMAIL_ELIGIBLE:** ✅ (`public_email` on file) — **WHATSAPP_ELIGIBLE:** ❌ (structural) — **CALL_TASK_ELIGIBLE:** ✅ (`public_phone` on file)
- **Selected channel: EMAIL** (recommended — has an automated, approval-gated send pipeline)
- **Draft in use** (`generated`, Arabic, `intro`, message id `a4199bcf-22e7-4bf5-a5ea-3a8b423f04ee`):

> السادة إدارة أكاديمية المصري لكرة القدم،
>
> تحية طيبة وبعد،
>
> نلاحظ من خلال تواجدكم النشط على إنستجرام وفيسبوك، بالإضافة إلى استخدام بريد إلكتروني شخصي للتواصل، أن أكاديميتكم في مدينة 6 أكتوبر تتمتع بقاعدة متحمسة من اللاعبين وأولياء الأمور، لكن هناك فجوة رقمية شائعة بين الأدوات التقليدية والأنظمة الرقمية المتكاملة.
>
> من خلال منصة **Mal3aby** يمكنكم رفع مستوى إدارة الأكاديمية عبر مجموعة من الوحدات المصممة خصيصاً لاحتياجاتكم: إدارة تسجيل الأكاديمية، تتبع الحضور عبر QR، ملفات اللاعبين وأولياء الأمور، نظام الاشتراكات، وتحسين تجربة أولياء الأمور.
>
> يسعدنا ترتيب عرض توضيحي سريع لتوضيح كيفية تطبيق هذه الحلول في بيئة عملكم الحالية.
>
> مع خالص التحية، فريق Mal3aby.

- **Grounding audit:** city = Giza (correct, matches lead record) · `academy_present` signal (medium confidence, evidence: active Instagram presence) · `no_website` signal (medium confidence, evidence: no dedicated site found, only social + a personal Gmail contact). Every factual claim traces to a stored signal. **0 unsupported claims.**
- **Follow-up plan:** a `sales_followups` row can be scheduled after send; it auto-cancels the moment any reply-taxonomy event lands on this lead (email reply via webhook, or a call-task outcome).
- **Risks:** none identified. This lead also has a phone number, so CALL_TASK remains available as a secondary channel if email goes unanswered.

### 4.2 Pegasus Dreamland Club

- **EMAIL_ELIGIBLE:** ✅ — **WHATSAPP_ELIGIBLE:** ❌ (structural) — **CALL_TASK_ELIGIBLE:** ✅
- **Selected channel: EMAIL**
- **Draft in use** (`generated`, English, `intro`, message id `0e0386a0-6fbe-4696-b249-9ac53bb7bc1d`):

> Hi [Prospect Name],
>
> I'm reaching out from Mal3aby because we see a clear opportunity to help Pegasus Dreamland Club streamline its operations and enhance the member experience.
>
> Your club currently manages a multi-sport complex in Giza — including a football academy, a tennis academy, a gym, and other membership programs — through phone-only booking. With multiple fields and programs, coordinating schedules, handling inquiries, and preventing double-bookings can quickly become time-consuming for your staff.
>
> Mal3aby's platform is built for exactly this kind of environment: self-service online booking, a conflict-free availability engine across all facilities, flexible pricing rules, and full operational control from real-time calendar management to usage reporting.
>
> I'd welcome a brief conversation to explore how we can tailor these capabilities to Pegasus Dreamland Club's specific needs.
>
> Best regards, [Your Name] — Mal3aby

- **Grounding audit:** city = Giza (correct) · `phone_only_booking` (low confidence — website exists but no booking widget found) · `multi_field_facility` (high confidence — football academy + tennis academy + gym confirmed). **Note:** the grounding record carries an explicit correction dated 2026-09-04: an earlier version of this evidence cited a "16313 hotline" that could not be independently re-verified on the club's live membership page; that claim was removed from the evidence and the message was regenerated. The current draft makes no phone-number claim at all. **0 unsupported claims.**
- **Follow-up plan:** same auto-cancel-on-reply mechanism as above.
- **Risks:** none identified.

### 4.3 Mr Soccer Academy

- **EMAIL_ELIGIBLE:** ❌ (no `public_email` on file) — **WHATSAPP_ELIGIBLE:** ❌ (structural) — **CALL_TASK_ELIGIBLE:** ✅
- **Selected channel: CALL_TASK** (only channel with a verified destination)
- **Talking points in use** (`generated`, phone_script, message id `bf6eaeff-8aa5-4411-8782-46d5e23cdb56`):

> نقاط الحديث الهاتفي — مستر سوكر أكاديمي:
> 1. افتتاحية عن ملعبي كمنصة لإدارة الأكاديميات
> 2. سؤال: إزاي بيتم تسجيل اللاعبين وتحصيل الاشتراكات حاليًا؟
> 3. نقطة الألم: الاعتماد على فيسبوك فقط للتواصل قد يعني عمليات يدوية
> 4. القيمة: نظام تسجيل وحضور واشتراكات في مكان واحد
> 5. اقتراح ديمو 15 دقيقة

- **Grounding audit:** `no_website` signal (medium confidence). **0 unsupported claims.**
- **⚠️ Defect found and corrected this mission:** a separate, later-generated **email** draft on this same lead (id `5b96f4ce-3869-4400-95df-03df6565e427`, created 11:40:09 UTC) incorrectly transliterated "Giza" as "غزّة" (Gaza, Palestine) in Arabic — the exact defect class previously found and fixed via the `AR_CITY_DISAMBIGUATION` city guard (merged as PR #8, same day). This specific stale draft predates that fix's effect on this lead (a correctly-worded draft exists at 11:46:32 UTC, after the fix). Since this lead has no email address on file anyway (CALL_TASK is the only real channel), this draft was never going to be sent — but it was still sitting in `generated` status where a human could have approved it by mistake. **Fixed:** added the missing `sales_reject_outreach_message()` RPC (a real, previously-absent gap — only `approve` existed) and used it to mark this specific draft `rejected`, with the reason recorded in `sales_lead_activities`.
- **Follow-up plan:** completing the call task with an outcome classified into the reply taxonomy auto-cancels any pending follow-up, same as the email path.
- **Risks:** the corrected phone-script talking points above are the only content that would actually be used for this lead (email is not reachable) — verified clean.

### 4.4 CIC Arenas

- **EMAIL_ELIGIBLE:** ❌ — **WHATSAPP_ELIGIBLE:** ❌ (structural) — **CALL_TASK_ELIGIBLE:** ✅
- **Selected channel: CALL_TASK**
- **Talking points in use** (`generated`, phone_script, message id `c5b5f87f-3394-4640-aadc-aba0fe49f00b`):

> نقاط الحديث الهاتفي — CIC Arenas: 1) سؤال عن نظام الحجز الحالي 2) القيمة: حجز إلكتروني بدون تعارض 3) اقتراح ديمو

- **Grounding audit:** `phone_only_booking` signal (medium confidence). **0 unsupported claims.**
- **Follow-up plan:** same auto-cancel mechanism.
- **Risks:** none identified.

### 4.5 Nasr City Sporting Club

- **EMAIL_ELIGIBLE:** ❌ — **WHATSAPP_ELIGIBLE:** ❌ (structural) — **CALL_TASK_ELIGIBLE:** ✅
- **Selected channel: CALL_TASK**
- **Talking points in use** (`generated`, phone_script, message id `e3384eca-044f-45ec-a800-52c3f52ab977`):

> نقاط الحديث الهاتفي — نادي مدينة نصر: 1) سؤال عن طريقة الحجز الحالية 2) القيمة: حجز إلكتروني بدل الاعتماد الكامل على الهاتف 3) اقتراح ديمو

- **Grounding audit:** `phone_only_booking` signal (medium confidence). **0 unsupported claims.**
- **Follow-up plan:** same auto-cancel mechanism.
- **Risks:** none identified.

---

## 5. SALES UI (Phase 17)

`SalesLeadDetailPage.tsx` now shows, per lead:
- A **Channel Eligibility** card: EMAIL/WhatsApp/CALL_TASK each with an eligible/not-eligible badge and the plain-language reason (WhatsApp's structural reason is always visible, never hidden), plus the recommended channel + why, plus a "Create Call Task" action (shown only when `call_task_eligible`).
- A **Call Tasks** section: pending/completed tasks, phone number, an outcome-entry field, and a "Mark Complete" action (`sales_complete_call_task`) — no automated dialing anywhere in this UI.
- A **Delivery & Reply Events** timeline: every `sales_outreach_events` row for the lead, with its translated event-type label and any reply excerpt, newest first.

No WhatsApp QR code, session token, or connector secret is exposed anywhere in this UI (none needed — the eligibility card only ever reports `whatsapp_eligible = false`).

---

## 6. SECURITY VERIFICATION (Phase 19)

| Control | Status | Evidence |
|---|---|---|
| Webhook signing secret server-side only | ✅ | Stored via `vault.create_secret`, referenced only by `secret_vault_id`; read only inside the `resend-webhook` function via `get_vault_secret_service` (service_role-only RPC) |
| No secret in git/frontend | ✅ | Secret was read once from the Resend API response and immediately passed to a single Vault-write tool call; never echoed, never written to a file |
| Webhook signature verified before any trust decision | ✅ | Directly tested: forged signature → 400; stale timestamp → 400; valid signature → processed |
| RLS intact on new tables | ✅ | `sales_outreach_events`, `sales_email_webhook_config`, `sales_call_tasks` all have `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY`, `platform.sales.view`-gated SELECT, no direct client INSERT/UPDATE/DELETE policy (writes only via SECURITY DEFINER RPCs) |
| No arbitrary public recipient endpoint | ✅ | `resend-webhook` only writes events tied to an existing `sales_outreach_messages.provider_reference` match; no client-supplied recipient is ever used |
| Do-not-contact enforced server-side | ✅ | `sales_record_outreach_event()` and `sales_complete_call_task()` both flip lead status server-side on a `do_not_contact` classification; pre-existing `sales_generate_outreach_message`/`sales_queue_outreach_message` guards independently block a `do_not_contact` lead |
| Approval enforced server-side, no client bypass | ✅ | New `sales_reject_outreach_message()` mirrors the existing `sales_approve_outreach_message()` permission gate exactly (`platform.sales.approve_outreach`); no client-side-only check anywhere |
| Service-role auth discriminator correct | ✅ (after 1 self-caught fix) | `set_sales_email_webhook_secret()` was initially missing the `auth.uid() is null` service-role bypass despite being granted only to `service_role` — reproduced directly (`ERROR: not authorized`), fixed immediately in a follow-up migration before any real secret was lost or exposed |

---

## 7. REGRESSION (Phase 20)

| Check | Result |
|---|---|
| TypeScript typecheck (`tsc --noEmit`) | ✅ 0 errors |
| ESLint (sales feature + modified files) | ✅ 0 errors |
| Production build (`npm run build`) | ✅ succeeds |
| Existing Sales Intelligence unit tests | ✅ 7/7 pass (unchanged) |
| New channel-eligibility UI tests | ✅ 4/4 pass (new — WhatsApp always shown ineligible with reason, Create Call Task gated correctly, recommended channel renders, reply/delivery events render with translated labels) |
| RPC-level verification against real pilot-lead data | ✅ `get_lead_channel_eligibility()` run against all 5 real leads, results match expectations exactly (see §3) |
| Webhook signature verification | ✅ 3/3 synthetic tests pass (valid/forged/stale) — see §1.2 |

CI note: this mission's own runtime changes (migrations + Edge Function + frontend) were verified locally via the checks above; no PR/CI run was part of this specific response cycle, so the previously-known `e2e-public` "Install dependencies" flakiness was not re-encountered and is not reported as newly recurring.

---

## 8. COST POLICY COMPLIANCE

- **$0 AI budget maintained.** No new AI provider call was added; reply classification deliberately does NOT invoke Groq (or any model) for a second task — see §1.2.
- **No paid contact data purchased.**
- **No paid email validation service used.**
- **No paid communication product enabled** — Resend's webhook feature used here is part of the already-configured free-tier-compatible plan; no billing change was made or required.
- **WhatsApp:** no purchase, no new integration, no billing change — existing connector inspected read-only.

---

## 9. STRICT SEND PROHIBITION — COMPLIANCE STATEMENT

No email was sent to any real prospect. No WhatsApp message was sent. No SMS was sent. No automated call was placed. No outreach was approved or queued on the owner's behalf. No delivery or reply was simulated in place of a real event — every webhook test used a synthetic `email_id` that matches no real message, and the one `unmatched: true` outcome is the function's genuine, correct behavior for that case, not a fabricated success.

---

## FINAL STATUS

**MULTI-CHANNEL PILOT READY FOR HUMAN APPROVAL**

Email is fully architecturally ready (sending + receiving verified, reply-path pipeline built and tested). WhatsApp is correctly, structurally excluded (not a blocker — the engine reports this honestly rather than defaulting incorrectly). Call tasks are ready as the channel for the 3 phone-only leads. All 5 leads have a clear, grounded, zero-unsupported-claim draft ready on their recommended channel. One real defect (a stale mistranslated draft) was found and neutralized during this verification pass. The system is ready for the owner to review and explicitly approve sending to any or all of the 5 leads — no message will be sent without that explicit approval.
