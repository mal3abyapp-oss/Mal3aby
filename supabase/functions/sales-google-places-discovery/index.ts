// sales-google-places-discovery -- Sales Intelligence Phase 2/3 (ADR-054,
// 2026-09-04): LeadSourceProvider implementation for Google Places API
// (New) Text Search. This is the ONLY provider adapter in this suite --
// Phase 2 explicitly requires "do not tightly couple discovery to
// Google Maps scraping", satisfied here by search()/fetchDetails()/
// normalize() being plain internal functions any future provider
// module could mirror, and by all persistence going through the SAME
// sales_upsert_discovered_lead()/sales_create_discovery_job() RPCs a
// manual-entry or website-form source would also use -- nothing about
// the dedup engine, scoring, or CRM pipeline is Google-specific.
//
// Uses the OFFICIAL Google Places API (New) only -- Text Search +
// Place Details. No scraping of Google's own search/maps HTML, no
// CAPTCHA bypass, no anti-bot evasion, no proxy rotation (Phase 2's
// explicit prohibitions). If sales_provider_configs.google_places has
// no credential configured, this function returns CONFIGURATION_BLOCKED
// (409) rather than a generic error, exactly mirroring the AI offer
// generator's own pattern.
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

const PLACES_API_TIMEOUT_MS = 15_000
const MAX_RESULTS_PER_RUN = 20 // one Text Search page -- pagination handled via job.next_page_token across multiple job runs, never a single unbounded fetch

interface GooglePlaceResult {
  id: string
  displayName?: { text: string }
  formattedAddress?: string
  location?: { latitude: number; longitude: number }
  rating?: number
  userRatingCount?: number
  websiteUri?: string
  nationalPhoneNumber?: string
  types?: string[]
}

// DISC-1 fix (2026-09-19/20, owner brief): "The discovered list
// contains irrelevant foreign venues (San Siro Stadium, Allianz Suisse
// Stadium, Wankdorf Stadium, St. Jakob-Park...)". Confirmed live and
// worse than "not filtered" -- these are REAL European stadiums
// (Milan/Zurich/Bern/Basel, confirmed via their own stored
// `address` field: "...Milano MI, Italy", "...Switzerland") that had
// been silently mislabeled country='EG' in this database, because
// sales_upsert_discovered_lead was always called with
// p_country: searchParams.country -- the SEARCH REQUEST's own input
// parameter, blindly assigned to every result regardless of where
// Google Places actually said the place is. Text Search has no
// geo-fence by default, so an unconstrained query like "stadium" can
// legitimately return results anywhere in the world.
//
// Two-layer fix: (1) regionCode, a documented Places API (New) Text
// Search request field that biases results toward the given region --
// NOT independently re-verified against live Google API docs in this
// session (no network doc access), included as a best-effort signal
// only; (2) a real hard filter in the caller below, checking each
// result's own formattedAddress against the expected country's
// English name -- the exact field this investigation confirmed LIVE
// already correctly contains the right country per result ("...Egypt"
// / "...Italy" / "...Switzerland", read directly from this database's
// own stored leads). Layer (2) is the actual guarantee this fix
// depends on -- correct regardless of whether layer (1) does anything
// at all, since it checks Google's own returned data rather than
// trusting a request-time hint to have worked.
const COUNTRY_CODE_TO_ENGLISH_NAME: Record<string, string> = {
  EG: 'Egypt',
  SA: 'Saudi Arabia',
  AE: 'United Arab Emirates',
  QA: 'Qatar',
  KW: 'Kuwait',
  BH: 'Bahrain',
  OM: 'Oman',
  JO: 'Jordan',
}

// search(): LeadSourceProvider.search() -- calls Places API (New) Text
// Search. p_query is the free-text query (e.g. "football fields in
// Cairo"), matching Phase 3's example searches directly.
async function searchPlaces(apiKey: string, query: string, regionCode: string | undefined, pageToken?: string): Promise<{ places: GooglePlaceResult[]; nextPageToken?: string }> {
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.websiteUri,places.nationalPhoneNumber,places.types,nextPageToken',
    },
    body: JSON.stringify({
      textQuery: query,
      pageSize: MAX_RESULTS_PER_RUN,
      ...(regionCode ? { regionCode } : {}),
      ...(pageToken ? { pageToken } : {}),
    }),
    signal: AbortSignal.timeout(PLACES_API_TIMEOUT_MS),
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    throw new Error(`Places API search failed: ${res.status} ${errBody.slice(0, 200)}`)
  }

  const data = await res.json()
  return { places: data.places ?? [], nextPageToken: data.nextPageToken }
}

// normalize(): LeadSourceProvider.normalize() -- maps a raw Places
// result into the exact parameter shape sales_upsert_discovered_lead()
// expects. Business-type inference is a simple keyword match against
// Google's own place `types` array -- never invented beyond what
// Google itself categorized the place as.
function inferBusinessType(types: string[] | undefined): string | null {
  if (!types) return null
  if (types.includes('stadium') || types.some((t) => t.includes('sports_complex'))) return 'multi_sport'
  if (types.some((t) => t.includes('sports_club') || t.includes('gym'))) return 'sports_club'
  return null
}

function normalizePlace(place: GooglePlaceResult): {
  business_name: string
  place_id: string
  website: string | null
  phone: string | null
  address: string | null
  lat: number | null
  lng: number | null
  rating: number | null
  review_count: number | null
  business_type: string | null
} {
  return {
    business_name: place.displayName?.text ?? 'Unknown',
    place_id: place.id,
    website: place.websiteUri ?? null,
    phone: place.nationalPhoneNumber ?? null,
    address: place.formattedAddress ?? null,
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    rating: place.rating ?? null,
    review_count: place.userRatingCount ?? null,
    business_type: inferBusinessType(place.types),
  }
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

  let body: { job_id?: string; query?: string; country?: string; city?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse(req, { error: 'malformed JSON body' }, 400)
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

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: providerConfig } = await admin
    .from('sales_provider_configs')
    .select('enabled, secret_vault_id')
    .eq('provider_key', 'google_places')
    .maybeSingle()

  if (!providerConfig?.enabled || !providerConfig.secret_vault_id) {
    return jsonResponse(req, {
      error: 'CONFIGURATION_BLOCKED',
      detail: 'The Google Places provider has not been configured with credentials. An operator must configure this in Sales Intelligence > Settings before Google-sourced discovery can run.',
    }, 409)
  }

  // Quota check via the CALLER-scoped client -- the real interactive user
  // triggering discovery, re-verified server-side.
  const { data: quota, error: quotaError } = await callerClient.rpc('sales_check_and_increment_quota', {
    p_provider_key: 'google_places',
  })
  if (quotaError) {
    return jsonResponse(req, { error: 'not authorized' }, 403)
  }
  if (!quota || !quota[0]?.allowed) {
    return jsonResponse(req, { error: 'daily discovery quota exceeded for google_places', quota: quota?.[0] }, 429)
  }

  let jobId = body.job_id

  if (!jobId) {
    if (!body.query) {
      return jsonResponse(req, { error: 'either job_id (to resume) or query (to start a new job) is required' }, 400)
    }
    const { data: newJobId, error: createError } = await callerClient.rpc('sales_create_discovery_job', {
      p_source_key: 'google_places',
      p_search_params: { query: body.query, country: body.country ?? null, city: body.city ?? null },
    })
    if (createError || !newJobId) {
      return jsonResponse(req, { error: 'could not create discovery job' }, 500)
    }
    jobId = newJobId
  }

  const { data: claimed, error: claimError } = await admin.rpc('sales_claim_discovery_job')
  if (claimError) {
    return jsonResponse(req, { error: 'could not claim a discovery job to process' }, 500)
  }
  if (!claimed || claimed.length === 0) {
    return jsonResponse(req, { error: 'no pending discovery job found to process (it may already be running elsewhere)' }, 409)
  }

  const job = claimed[0]

  const { data: decryptedSecret, error: secretError } = await admin.rpc('get_vault_secret_service', {
    p_secret_id: providerConfig.secret_vault_id,
  })

  if (secretError || !decryptedSecret) {
    await admin.rpc('sales_finish_discovery_job', {
      p_job_id: job.job_id,
      p_status: 'failed',
      p_discovered_count: 0,
      p_new_count: 0,
      p_duplicate_count: 0,
      p_failed_count: 0,
      p_skipped_count: 0,
      p_error_class: 'credential_error',
      p_last_error: 'could not resolve Google Places credentials',
    })
    return jsonResponse(req, { error: 'could not resolve Google Places credentials' }, 500)
  }

  const searchParams = job.search_params as { query?: string; country?: string; city?: string }
  const query = searchParams.query ?? ''
  // DISC-1 fix: country is no longer optional-and-silently-trusted --
  // defaults to EG (this platform's own stated market, matching every
  // other country default already in this codebase, e.g.
  // SalesDiscoverPage.tsx's own manual-entry form) when the caller
  // didn't specify one, and is now the single source of truth checked
  // against each real result below rather than blindly stamped onto
  // every row.
  const expectedCountryCode = (searchParams.country || 'EG').toUpperCase()
  const expectedCountryName = COUNTRY_CODE_TO_ENGLISH_NAME[expectedCountryCode]

  try {
    const { places, nextPageToken } = await searchPlaces(decryptedSecret, query, expectedCountryCode, job.next_page_token ?? undefined)

    let newCount = 0
    let duplicateCount = 0
    let failedCount = 0
    let irrelevantCount = 0
    // ENR-1 fix (2026-09-19/20, owner brief): "one job shows 20
    // discovered and 20 failed without a reason." Confirmed real --
    // upsertError was captured per-place inside this loop but
    // completely discarded, never logged or stored anywhere. A job
    // that failed every single place gave zero diagnostic information
    // to the operator. sales_finish_discovery_job already accepts
    // p_error_class/p_last_error (used on the outer exception path
    // below, just never on this per-place path) -- now also passed
    // here whenever at least one place failed, capturing the LAST
    // failure's message (each place can fail for a different reason;
    // one real message is a real improvement over zero, and matches
    // this job-level table's own single last_error column shape).
    let lastUpsertErrorMessage: string | null = null

    for (const place of places) {
      const normalized = normalizePlace(place)

      // DISC-1 hard filter: regionCode above is a bias, not a
      // guarantee (Google's own documented behavior) -- this is the
      // real enforcement. Only applied when we know the expected
      // country's English name (COUNTRY_CODE_TO_ENGLISH_NAME); an
      // unmapped country code skips this check rather than rejecting
      // every result, since we cannot verify what we cannot recognize.
      if (expectedCountryName && normalized.address && !normalized.address.toLowerCase().includes(expectedCountryName.toLowerCase())) {
        irrelevantCount++
        continue
      }

      const { data: result, error: upsertError } = await admin.rpc('sales_upsert_discovered_lead', {
        p_source_key: 'google_places',
        p_business_name: normalized.business_name,
        p_business_type: normalized.business_type,
        p_place_id: normalized.place_id,
        p_website: normalized.website,
        p_phone: normalized.phone,
        p_email: null,
        // DISC-1 fix: previously the search REQUEST's own input
        // parameter was blindly stamped onto every result regardless
        // of where the place actually is -- now the verified expected
        // country (the result already passed the address check above,
        // so this is no longer an unverified assumption).
        p_country: expectedCountryCode,
        p_city: searchParams.city ?? null,
        p_area: null,
        p_address: normalized.address,
        p_lat: normalized.lat,
        p_lng: normalized.lng,
        p_rating: normalized.rating,
        p_review_count: normalized.review_count,
      })

      if (upsertError || !result || result.length === 0) {
        failedCount++
        lastUpsertErrorMessage = upsertError?.message?.slice(0, 500) ?? 'sales_upsert_discovered_lead returned no result'
        continue
      }

      if (result[0].outcome === 'new' || result[0].outcome === 'new_possible_duplicate') {
        newCount++
      } else {
        duplicateCount++
      }
    }

    const finalStatus = nextPageToken ? 'partial' : 'completed'

    await admin.rpc('sales_finish_discovery_job', {
      p_job_id: job.job_id,
      p_status: finalStatus,
      p_discovered_count: places.length,
      p_new_count: newCount,
      p_duplicate_count: duplicateCount,
      p_failed_count: failedCount,
      // DISC-1 fix: irrelevantCount (results whose own address didn't
      // match the expected country -- rejected before ever reaching
      // sales_upsert_discovered_lead) now surfaces as skipped_count
      // instead of the previous hardcoded 0, so an operator can see
      // discovery genuinely filtered something rather than either
      // silently keeping it (the original bug) or the count looking
      // identical to "nothing was ever skipped".
      p_skipped_count: irrelevantCount,
      p_next_page_token: nextPageToken ?? null,
      p_error_class: failedCount > 0 ? 'per_lead_upsert_error' : null,
      p_last_error: failedCount > 0 ? lastUpsertErrorMessage : null,
    })

    return jsonResponse(req, {
      job_id: job.job_id,
      status: finalStatus,
      discovered: places.length,
      new: newCount,
      duplicates: duplicateCount,
      failed: failedCount,
      has_more_pages: !!nextPageToken,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unexpected discovery error'
    await admin.rpc('sales_finish_discovery_job', {
      p_job_id: job.job_id,
      p_status: 'retryable',
      p_discovered_count: 0,
      p_new_count: 0,
      p_duplicate_count: 0,
      p_failed_count: 0,
      p_skipped_count: 0,
      p_error_class: 'provider_error',
      p_last_error: message.slice(0, 500),
    })
    return jsonResponse(req, { error: 'discovery run failed, job marked retryable' }, 502)
  }
})
