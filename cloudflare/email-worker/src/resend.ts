/**
 * resend.ts -- thin client for Resend's REST API. No SDK dependency
 * (directive section 12: "Use Resend REST API. Do NOT use SMTP unless
 * there is a proven reason") -- a single fetch() call is simpler than
 * pulling in the `resend` npm package for one endpoint, and keeps this
 * Worker's bundle small.
 *
 * SECURITY (directive section 39): RESEND_API_KEY is read from env
 * and used only in the Authorization header of this one outbound
 * fetch call -- never logged, never included in any thrown error
 * message, never echoed back in a response. sendEmail()'s own error
 * path deliberately strips the Authorization header before including
 * any diagnostic detail in its return value.
 */

export interface SendEmailInput {
  apiKey: string
  from: string
  to: string
  subject: string
  html: string
  text: string
  /** Resend's own idempotency mechanism (directive section 38) -- in addition to, never instead of, this project's own notification_queue.dedup_key DB-level idempotency. */
  idempotencyKey: string
}

export type SendEmailResult =
  | { outcome: 'sent'; providerReference: string }
  | { outcome: 'rate_limited'; retryAfterSeconds: number | null }
  | { outcome: 'temporary_failure'; statusCode: number; errorClass: string }
  | { outcome: 'permanent_failure'; statusCode: number; errorClass: string }

const RESEND_API_URL = 'https://api.resend.com/emails'

/**
 * Classifies a Resend HTTP response into the retry-policy buckets
 * directive section 14 requires: temporary (429, 5xx, network) vs
 * permanent (4xx recipient/domain errors) -- retried indefinitely
 * only within the caller's own bounded-attempt loop, never here.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  let response: Response
  try {
    response = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    })
  } catch {
    // Network-level failure (DNS, connection reset, timeout) -- always
    // temporary, never a reason to permanently suppress the recipient.
    return { outcome: 'temporary_failure', statusCode: 0, errorClass: 'network_error' }
  }

  if (response.status === 429) {
    const retryAfterHeader = response.headers.get('Retry-After')
    const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : null
    return { outcome: 'rate_limited', retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null }
  }

  if (response.ok) {
    let body: { id?: string } = {}
    try {
      body = (await response.json()) as { id?: string }
    } catch {
      // Accepted but body wasn't valid JSON -- still a success, just no
      // provider reference to store.
    }
    return { outcome: 'sent', providerReference: body.id ?? '' }
  }

  // 5xx -- Resend-side failure, always temporary.
  if (response.status >= 500) {
    return { outcome: 'temporary_failure', statusCode: response.status, errorClass: 'provider_5xx' }
  }

  // 4xx (excluding 429, handled above) -- permanent by default
  // (invalid recipient, malformed request, domain/sender rejected).
  // Never includes the raw response body in the returned errorClass
  // (could theoretically echo back request content) -- only a coarse
  // classification safe to persist in notification_queue.last_error.
  //
  // TEMPORARY DIAGNOSTIC (2026-08-24): logging Resend's own error body
  // to wrangler tail to pin down a live 401 -- this body describes
  // what Resend rejected about the REQUEST (e.g. unverified sender
  // domain, malformed field), it never contains the API key itself
  // (the key is only ever sent, never echoed back in any response).
  // Remove once the root cause is confirmed and fixed.
  try {
    const diagBody = await response.clone().text()
    console.error('resend_error_body', response.status, diagBody.slice(0, 500))
  } catch {
    // best-effort diagnostic only
  }

  return { outcome: 'permanent_failure', statusCode: response.status, errorClass: response.status === 401 || response.status === 403 ? 'auth_or_permission_error' : 'invalid_request_or_recipient' }
}
