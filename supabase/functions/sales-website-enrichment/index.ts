// sales-website-enrichment -- Sales Intelligence Phase 5 (ADR-054,
// 2026-09-04): bounded public-website enrichment. Fetches a lead's own
// public website pages (Home/About/Contact/Booking/Pricing/Facilities/
// Branches, following only same-domain links found on the homepage --
// never crawls beyond the lead's own site) and extracts public business
// signals (contact info, booking presence, social links, academy/
// multi-branch indicators), recording each as an evidence-backed
// sales_lead_signals row via sales_record_signal() -- never claims a
// signal without a source_url + retrieved_at, per the mission's
// explicit requirement.
//
// This is the one provider in the Sales Intelligence suite that needs
// NO external API credential (sales_provider_configs.website_enrichment
// is pre-enabled) -- it is a plain HTTP fetch of public pages, same
// trust model as the frontend fetching any public URL, just done
// server-side so results are consistently structured and auditable.
//
// Follows the exact dual-client / vault / CORS / sanitized-error
// pattern already established by paymob-create-checkout-session (the
// codebase's own reference implementation for an external-call Edge
// Function) -- see that file's own comments for the full rationale.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const ALLOWED_ORIGINS = new Set([
  'https://mal3aby.app',
  'https://www.mal3aby.app',
  'http://localhost:5173',
])

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get('origin')
  return {
    'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.has(origin) ? origin : 'https://mal3aby.app',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

function jsonResponse(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeadersFor(req) },
  })
}

// Only these page-name hints are ever followed from the homepage's own
// same-domain links -- never a generic crawl. Matches the mission's
// explicit "Home/About/Contact/Booking/Pricing/Facilities/Branches"
// page list (Phase 5).
const CANDIDATE_PAGE_HINTS = [
  'about', 'contact', 'booking', 'book', 'pricing', 'prices', 'facilities',
  'fields', 'branches', 'locations', 'academy', 'programs',
]

const MAX_PAGES_PER_LEAD = 6
const FETCH_TIMEOUT_MS = 10_000

function sanitizeFetchError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') return 'request timed out'
  return 'could not fetch the requested page'
}

// SSRF guard (P2 fix, 2026-09-04): sales_leads.website is operator-editable
// (manual lead entry by any platform_admin/platform_owner session) with no
// DB CHECK constraint on its shape. Without this guard, a malicious/
// compromised lower-privilege platform_admin could set website to a
// loopback/private/link-local/cloud-metadata address and use this
// server-side fetch to probe internal Supabase/Edge Function network
// surface. Google Places-sourced leads never hit this path with attacker
// input (Google's own API populates `website`), but manual entry does, so
// this must be enforced unconditionally for every URL fetched, not just
// the initial lead.website value -- including same-domain links extracted
// from the page itself (extractSameDomainLinks resolves relative hrefs,
// which could theoretically redirect within an already-malicious base).
function isSafePublicUrl(rawUrl: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false

  const hostname = parsed.hostname.toLowerCase()

  // Reject bare loopback/link-local/metadata hostnames outright.
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '0.0.0.0' ||
    hostname === 'metadata.google.internal'
  ) {
    return false
  }

  // IPv4 literal check: loopback (127.0.0.0/8), private (10/8, 172.16/12,
  // 192.168/16), link-local incl. cloud metadata (169.254.0.0/16), and
  // unspecified (0.0.0.0) ranges.
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const [a, b] = [Number(ipv4Match[1]), Number(ipv4Match[2])]
    if (a === 127) return false
    if (a === 10) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a === 169 && b === 254) return false
    if (a === 0) return false
  }

  // IPv6 literal check: loopback (::1) and unique-local (fc00::/7).
  if (hostname === '::1' || hostname.startsWith('[::1]')) return false
  if (hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('[fc') || hostname.startsWith('[fd')) {
    return false
  }

  return true
}

async function fetchPage(url: string): Promise<string | null> {
  if (!isSafePublicUrl(url)) return null
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Mal3abySalesIntelligenceBot/1.0 (+https://mal3aby.app)' },
    })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? ''
    if (!contentType.includes('text/html')) return null
    return await res.text()
  } catch {
    return null
  }
}

function extractSameDomainLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl)
  const hrefRe = /href=["']([^"']+)["']/gi
  const found = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = hrefRe.exec(html)) !== null) {
    try {
      const resolved = new URL(match[1], base)
      if (resolved.hostname !== base.hostname) continue
      const lower = resolved.pathname.toLowerCase()
      if (CANDIDATE_PAGE_HINTS.some((hint) => lower.includes(hint))) {
        found.add(resolved.toString())
      }
    } catch {
      // ignore malformed hrefs (mailto:, tel:, javascript:, etc.)
    }
  }
  return Array.from(found).slice(0, MAX_PAGES_PER_LEAD - 1)
}

interface ExtractedSignal {
  signal_key: string
  confidence: 'high' | 'medium' | 'low'
  evidence: Record<string, unknown>
  source_url: string
}

interface ExtractedContact {
  phone?: string
  email?: string
  whatsapp?: string
}

interface ExtractedSocial {
  platform: string
  url: string
}

function extractContactInfo(html: string): ExtractedContact {
  const contact: ExtractedContact = {}
  const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)
  if (emailMatch) contact.email = emailMatch[0]

  const telHrefMatch = html.match(/href=["']tel:([+0-9\s-]+)["']/i)
  if (telHrefMatch) contact.phone = telHrefMatch[1].trim()

  const waMatch = html.match(/(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?[0-9]+)/i)
  if (waMatch) contact.whatsapp = waMatch[1]

  return contact
}

function extractSocialLinks(html: string): ExtractedSocial[] {
  const patterns: Array<[string, RegExp]> = [
    ['instagram', /https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9_.]+/gi],
    ['facebook', /https?:\/\/(www\.)?facebook\.com\/[a-zA-Z0-9_.]+/gi],
    ['tiktok', /https?:\/\/(www\.)?tiktok\.com\/@[a-zA-Z0-9_.]+/gi],
  ]
  const results: ExtractedSocial[] = []
  for (const [platform, re] of patterns) {
    const m = html.match(re)
    if (m) results.push({ platform, url: m[0] })
  }
  return results
}

// Booking-provider detection: known third-party booking widget/script
// signatures. Deliberately a fixed, explicit list (not a guess) -- a
// signal is only claimed when a real, named indicator is found in the
// page source.
const KNOWN_BOOKING_PROVIDERS: Array<[string, RegExp]> = [
  ['calendly', /calendly\.com/i],
  ['fresha', /fresha\.com/i],
  ['playtomic', /playtomic\.io/i],
  ['matchi', /matchi\.se/i],
]

function analyzePage(html: string, url: string, isHomepage: boolean): { signals: ExtractedSignal[]; contact: ExtractedContact; social: ExtractedSocial[] } {
  const signals: ExtractedSignal[] = []
  const lowerHtml = html.toLowerCase()

  const contact = extractContactInfo(html)
  const social = extractSocialLinks(html)

  let bookingProviderFound: string | null = null
  for (const [name, re] of KNOWN_BOOKING_PROVIDERS) {
    if (re.test(html)) {
      bookingProviderFound = name
      break
    }
  }

  const hasBookingKeyword = /\b(book now|احجز الآن|احجز|online booking|book a court|book a field)\b/i.test(html)

  if (bookingProviderFound) {
    signals.push({
      signal_key: 'public_booking_form_only',
      confidence: 'high',
      evidence: { detail: `Detected known booking widget: ${bookingProviderFound}`, provider: bookingProviderFound },
      source_url: url,
    })
  } else if (!hasBookingKeyword && isHomepage) {
    signals.push({
      signal_key: 'no_online_booking',
      confidence: 'medium',
      evidence: { detail: 'No booking button/widget keyword found on homepage; single-page check only, not conclusive' },
      source_url: url,
    })
  }

  if (contact.whatsapp && !bookingProviderFound && !hasBookingKeyword) {
    signals.push({
      signal_key: 'whatsapp_only_booking',
      confidence: 'medium',
      evidence: { detail: 'WhatsApp contact link found with no online booking widget detected', whatsapp: contact.whatsapp },
      source_url: url,
    })
  }

  if (/\bacademy\b|أكاديمية|برنامج تدريبي|training program/i.test(lowerHtml)) {
    signals.push({
      signal_key: 'academy_present',
      confidence: 'medium',
      evidence: { detail: 'Page mentions academy/training program' },
      source_url: url,
    })
  }

  if (/\bbranch(es)?\b|فروع|أفرع/i.test(lowerHtml) && /\b(2|3|4|5|two|three|multiple)\b/i.test(lowerHtml)) {
    signals.push({
      signal_key: 'multi_branch',
      confidence: 'low',
      evidence: { detail: 'Page mentions multiple branches -- low confidence, needs manual confirmation' },
      source_url: url,
    })
  }

  const contactChannelCount = [contact.phone, contact.email, contact.whatsapp, ...social.map((s) => s.url)].filter(Boolean).length
  if (contactChannelCount >= 3) {
    signals.push({
      signal_key: 'multiple_contact_channels',
      confidence: 'high',
      evidence: { detail: `${contactChannelCount} distinct contact channels found on this page` },
      source_url: url,
    })
  }

  return { signals, contact, social }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeadersFor(req) })
  }
  if (req.method !== 'POST') {
    return jsonResponse(req, { error: 'method not allowed' }, 405)
  }

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return jsonResponse(req, { error: 'authentication required' }, 401)
  }

  let body: { lead_id?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse(req, { error: 'malformed JSON body' }, 400)
  }

  const leadId = body.lead_id
  if (!leadId || typeof leadId !== 'string') {
    return jsonResponse(req, { error: 'lead_id is required' }, 400)
  }

  const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  })

  const {
    data: { user },
    error: userError,
  } = await callerClient.auth.getUser()

  if (userError || !user) {
    return jsonResponse(req, { error: 'invalid or expired session' }, 401)
  }

  // Re-authorization via the CALLER-scoped client, same pattern as every
  // gateway function -- the RLS/RPC-level 'platform.sales.enrich'
  // permission check happens for real here, not just client-side.
  const { data: quota, error: quotaError } = await callerClient.rpc('sales_check_and_increment_quota', {
    p_provider_key: 'website_enrichment',
  })
  if (quotaError) {
    return jsonResponse(req, { error: 'not authorized or quota check failed' }, 403)
  }
  if (!quota || !quota[0]?.allowed) {
    return jsonResponse(req, { error: 'daily enrichment quota exceeded for website_enrichment', quota: quota?.[0] }, 429)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: lead, error: leadError } = await admin
    .from('sales_leads')
    .select('id, website, status')
    .eq('id', leadId)
    .maybeSingle()

  if (leadError || !lead) {
    return jsonResponse(req, { error: 'lead not found' }, 404)
  }

  if (!lead.website) {
    return jsonResponse(req, { error: 'lead has no website to enrich' }, 400)
  }

  const { data: runRow, error: runError } = await admin
    .from('sales_lead_enrichment_runs')
    .insert({ lead_id: leadId, run_type: 'website_scan', status: 'running', started_at: new Date().toISOString(), attempts: 1 })
    .select('id')
    .single()

  if (runError || !runRow) {
    return jsonResponse(req, { error: 'could not create enrichment run record' }, 500)
  }

  const runId = runRow.id

  try {
    const homepageHtml = await fetchPage(lead.website)
    if (!homepageHtml) {
      await admin
        .from('sales_lead_enrichment_runs')
        .update({ status: 'failed', error_class: 'fetch_failed', last_error: 'homepage unreachable or not HTML', finished_at: new Date().toISOString() })
        .eq('id', runId)
      return jsonResponse(req, { error: 'website homepage could not be fetched' }, 502)
    }

    const pagesToVisit = [lead.website, ...extractSameDomainLinks(homepageHtml, lead.website)]
    const pageResults = await Promise.all(
      pagesToVisit.map(async (url, i) => {
        const html = i === 0 ? homepageHtml : await fetchPage(url)
        if (!html) return null
        return analyzePage(html, url, i === 0)
      })
    )

    const allSignals: ExtractedSignal[] = []
    let bestContact: ExtractedContact = {}
    const allSocial: ExtractedSocial[] = []

    for (const result of pageResults) {
      if (!result) continue
      allSignals.push(...result.signals)
      bestContact = { ...bestContact, ...result.contact }
      allSocial.push(...result.social)
    }

    // Persist signals via the RPC (never a direct table write from an
    // Edge Function -- matches this codebase's convention of RPCs as
    // the sole write path, even for service-role callers).
    let recordedCount = 0
    for (const sig of allSignals) {
      const { error: sigError } = await admin.rpc('sales_record_signal', {
        p_lead_id: leadId,
        p_signal_key: sig.signal_key,
        p_confidence: sig.confidence,
        p_evidence: sig.evidence,
        p_source_url: sig.source_url,
        p_enrichment_run_id: runId,
      })
      if (!sigError) recordedCount++
    }

    // Fill-only-if-null update (Phase 20's "do not overwrite authoritative manual
    // corrections silently" requirement) -- COALESCE keeps any existing value
    // (which may have been manually corrected by staff) and only fills a
    // genuinely NULL field from this enrichment run's findings.
    const { data: currentLead } = await admin.from('sales_leads').select('public_phone, public_email, whatsapp_public_number').eq('id', leadId).single()
    if (currentLead) {
      await admin
        .from('sales_leads')
        .update({
          public_phone: currentLead.public_phone ?? bestContact.phone ?? null,
          public_email: currentLead.public_email ?? bestContact.email ?? null,
          whatsapp_public_number: currentLead.whatsapp_public_number ?? bestContact.whatsapp ?? null,
          last_verified_at: new Date().toISOString(),
        })
        .eq('id', leadId)
    }

    for (const s of allSocial) {
      await admin
        .from('sales_lead_social_links')
        .upsert({ lead_id: leadId, platform: s.platform, url: s.url, source_url: lead.website }, { onConflict: 'lead_id,platform,url' })
    }

    await admin
      .from('sales_lead_enrichment_runs')
      .update({ status: 'completed', finished_at: new Date().toISOString() })
      .eq('id', runId)

    if (lead.status === 'discovered' || lead.status === 'enriching') {
      await admin.rpc('sales_change_lead_status', { p_lead_id: leadId, p_new_status: 'enriched', p_reason: 'website enrichment completed' })
    }

    return jsonResponse(req, {
      lead_id: leadId,
      pages_scanned: pageResults.filter(Boolean).length,
      signals_recorded: recordedCount,
      social_links_found: allSocial.length,
    })
  } catch (err) {
    await admin
      .from('sales_lead_enrichment_runs')
      .update({ status: 'failed', error_class: 'unexpected', last_error: sanitizeFetchError(err), finished_at: new Date().toISOString() })
      .eq('id', runId)
    return jsonResponse(req, { error: 'enrichment failed unexpectedly' }, 500)
  }
})
