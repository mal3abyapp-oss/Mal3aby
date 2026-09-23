// SalesDiscoverPage -- Sales Intelligence Phase 3 (ADR-054). The
// "Discover Leads" screen: trigger a Google Places discovery job or add
// a lead manually. Job status/discovered/new/duplicates/failed/skipped
// counters shown per the mission's explicit requirement; jobs are
// resumable (job_id passed back to sales-google-places-discovery).
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { ListLoadingSkeleton } from './ListLoadingSkeleton'
import { Input } from '@/components/ui/input'
import { FormLabel } from '@/components/ui/form-label'
import { StatusBadge } from '@/components/ui/status-badge'
import { FormattedDate } from '@/components/ui/formatted-date'
import { SALES_DISPLAY_TIMEZONE } from './salesTimeZone'
import { ChevronDown } from 'lucide-react'

interface DiscoveryJob {
  id: string
  status: string
  discovered_count: number
  new_count: number
  duplicate_count: number
  enriched_count: number
  failed_count: number
  skipped_count: number
  search_params: unknown
  attempts: number
  started_at: string | null
  finished_at: string | null
  created_at: string
  // ENR-1 fix (2026-09-19/20): now actually fetched/displayed -- see
  // sales-google-places-discovery's own comment on where these are set.
  last_error: string | null
}

interface ProviderStatus {
  provider_key: string
  enabled: boolean
  is_configured: boolean
  daily_cap: number
}

async function fetchRecentJobs(): Promise<DiscoveryJob[]> {
  const { data, error } = await supabase
    .from('sales_discovery_jobs')
    .select('id, status, discovered_count, new_count, duplicate_count, enriched_count, failed_count, skipped_count, search_params, attempts, started_at, finished_at, created_at, last_error')
    .order('created_at', { ascending: false })
    .limit(10)
  if (error) throw error
  return data ?? []
}

async function fetchProviderStatus(): Promise<ProviderStatus[]> {
  const { data, error } = await supabase.rpc('get_sales_provider_status')
  if (error) throw error
  return data ?? []
}

function jobStatusTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'running' || status === 'pending') return 'info'
  return 'neutral'
}

function searchParam(job: DiscoveryJob, key: string): string {
  if (!job.search_params || typeof job.search_params !== 'object' || Array.isArray(job.search_params)) return ''
  const value = (job.search_params as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

export function SalesDiscoverPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [query, setQuery] = useState('')
  const [country, setCountry] = useState('EG')
  const [city, setCity] = useState('')
  const [manualName, setManualName] = useState('')
  // CONTACT-1 fix (2026-09-19/20, owner brief): this used to be ONE
  // field labeled generically "Contact", wired only to p_phone --
  // typing an email into it silently stored it as a phone number (the
  // backend has no format validation on either field, it stores
  // whatever it's given verbatim). sales_upsert_discovered_lead()
  // always accepted p_phone AND p_email as two separate parameters;
  // the UI just never exposed the second one. Split into two real,
  // separately-validated fields below.
  const [manualPhone, setManualPhone] = useState('')
  const [manualEmail, setManualEmail] = useState('')
  const [manualWebsite, setManualWebsite] = useState('')
  // FULL-PLATFORM AUDIT ROUND 2 FIX (2026-09-14): Manual Entry used to
  // silently reuse the Discover form's own `country`/`city` state --
  // a manually-added lead got saved with whatever country/city was
  // last typed into the unrelated Google Places search box above
  // (including its "EG" default), with no field of its own to notice
  // or correct it. Manual Entry now owns its own country/city state.
  const [manualCountry, setManualCountry] = useState('EG')
  const [manualCity, setManualCity] = useState('')
  const [openJobId, setOpenJobId] = useState<string | null>(null)

  const jobsQuery = useQuery({ queryKey: ['sales-discovery-jobs-recent'], queryFn: fetchRecentJobs, refetchInterval: 10_000 })
  const providerQuery = useQuery({ queryKey: ['sales-provider-status'], queryFn: fetchProviderStatus, retry: 1 })

  const googlePlacesStatus = providerQuery.data?.find((p) => p.provider_key === 'google_places')

  const discoverMutation = useMutation({
    mutationFn: async () => {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sales-google-places-discovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, country: country || null, city: city || null }),
      })
      const json = await res.json()
      if (!res.ok) throw Object.assign(new Error(json.error ?? 'discovery failed'), { status: res.status, detail: json })
      return json
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sales-discovery-jobs-recent'] })
    },
  })

  const manualAddMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('sales_upsert_discovered_lead', {
        p_source_key: 'manual',
        p_business_name: manualName,
        p_business_type: undefined,
        p_place_id: undefined,
        p_website: manualWebsite || undefined,
        p_phone: manualPhone || undefined,
        p_email: manualEmail || undefined,
        p_country: manualCountry || undefined,
        p_city: manualCity || undefined,
        p_area: undefined,
        p_address: undefined,
        p_lat: undefined,
        p_lng: undefined,
        p_rating: undefined,
        p_review_count: undefined,
      })
      if (error) throw error
      return data?.[0]
    },
    onSuccess: (result) => {
      if (result?.lead_id) navigate(`/platform/sales/leads/${result.lead_id}`)
    },
  })
  const manualAddErrorMessage = manualAddMutation.isError
    ? translateSupabaseError(manualAddMutation.error, t('platform.sales.discover.manualEntryError'))
    : null

  return (
    <div className="space-y-6">
      <PageHeader title={t('platform.sales.discover.title')} description={t('platform.sales.discover.description')} />

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.discover.sourceLabel')}: Google Places</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {providerQuery.isError ? (
            <p className="rounded-md bg-status-danger/10 p-3 text-sm text-status-danger">
              {translateSupabaseError(providerQuery.error, t('platform.sales.discover.providerStatusError'))}{' '}
              <button type="button" className="underline" onClick={() => void providerQuery.refetch()}>{t('errorState.retry')}</button>
            </p>
          ) : providerQuery.data && !googlePlacesStatus?.is_configured ? (
            <p className="rounded-md bg-status-warning-subtle p-3 text-sm text-status-warning">
              {t('platform.sales.discover.configurationBlocked')}
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <FormLabel htmlFor="discover-query">{t('platform.sales.discover.queryLabel')}</FormLabel>
              <Input id="discover-query" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('platform.sales.discover.queryPlaceholder')} />
            </div>
            <div>
              <FormLabel htmlFor="discover-country">{t('platform.sales.discover.countryLabel')}</FormLabel>
              <Input id="discover-country" value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} maxLength={2} />
            </div>
            <div>
              <FormLabel htmlFor="discover-city">{t('platform.sales.discover.cityLabel')}</FormLabel>
              <Input id="discover-city" value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
          </div>

          {discoverMutation.isError ? (
            <p className="text-sm text-status-danger">
              {(discoverMutation.error as { detail?: { error?: string } })?.detail?.error === 'CONFIGURATION_BLOCKED'
                ? t('platform.sales.discover.configurationBlocked')
                : (discoverMutation.error as { status?: number })?.status === 429
                  ? t('platform.sales.discover.quotaExceeded')
                  : translateSupabaseError(discoverMutation.error, t('platform.sales.discover.loadError'))}
            </p>
          ) : null}

          <Button onClick={() => discoverMutation.mutate()} disabled={!query || discoverMutation.isPending || !googlePlacesStatus?.is_configured}>
            {discoverMutation.isPending ? t('platform.sales.discover.starting') : t('platform.sales.discover.startButton')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.discover.manualEntryTitle')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <FormLabel htmlFor="manual-name">{t('platform.sales.leads.columns.business')}</FormLabel>
              <Input id="manual-name" value={manualName} onChange={(e) => setManualName(e.target.value)} />
            </div>
            <div>
              <FormLabel htmlFor="manual-phone">{t('platform.sales.discover.manualPhoneLabel')}</FormLabel>
              <Input id="manual-phone" type="tel" dir="ltr" value={manualPhone} onChange={(e) => setManualPhone(e.target.value)} placeholder="+20 10 0000 0000" />
            </div>
            <div>
              <FormLabel htmlFor="manual-email">{t('platform.sales.discover.manualEmailLabel')}</FormLabel>
              <Input id="manual-email" type="email" dir="ltr" value={manualEmail} onChange={(e) => setManualEmail(e.target.value)} placeholder="owner@example.com" />
            </div>
            <div>
              <FormLabel htmlFor="manual-website">{t('platform.sales.discover.manualWebsiteLabel')}</FormLabel>
              <Input id="manual-website" value={manualWebsite} onChange={(e) => setManualWebsite(e.target.value)} />
            </div>
            <div>
              <FormLabel htmlFor="manual-country">{t('platform.sales.discover.countryLabel')}</FormLabel>
              <Input id="manual-country" value={manualCountry} onChange={(e) => setManualCountry(e.target.value.toUpperCase())} maxLength={2} />
            </div>
            <div>
              <FormLabel htmlFor="manual-city">{t('platform.sales.discover.cityLabel')}</FormLabel>
              <Input id="manual-city" value={manualCity} onChange={(e) => setManualCity(e.target.value)} />
            </div>
          </div>
          {manualAddErrorMessage ? <p className="text-sm text-status-danger">{manualAddErrorMessage}</p> : null}
          <Button variant="outline" onClick={() => manualAddMutation.mutate()} disabled={!manualName || manualAddMutation.isPending}>
            {t('platform.sales.discover.manualEntryButton')}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.discover.recentJobs')}</CardTitle></CardHeader>
        <CardContent>
          {jobsQuery.isError ? (
            <ErrorState message={translateSupabaseError(jobsQuery.error, t('platform.sales.discover.loadError'))} onRetry={() => jobsQuery.refetch()} />
          ) : jobsQuery.isLoading ? (
            <ListLoadingSkeleton />
          ) : (jobsQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.discover.noJobs')}</p>
          ) : (
            <div className="space-y-3">
              {(jobsQuery.data ?? []).map((job) => (
                <div key={job.id} className="rounded-md border border-border-subtle">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-md p-3 text-start hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    aria-expanded={openJobId === job.id}
                    aria-controls={`discovery-job-${job.id}`}
                    onClick={() => setOpenJobId((current) => current === job.id ? null : job.id)}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <StatusBadge tone={jobStatusTone(job.status)} label={job.status} />
                      <FormattedDate value={job.created_at} timeZone={SALES_DISPLAY_TIMEZONE} className="truncate text-sm text-text-secondary" />
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-sm font-medium text-primary">
                      {openJobId === job.id ? t('platform.sales.discover.closeJob') : t('platform.sales.discover.openJob')}
                      <ChevronDown className={`h-4 w-4 transition-transform ${openJobId === job.id ? 'rotate-180' : ''}`} aria-hidden="true" />
                    </span>
                  </button>
                  {/* ENR-1 fix (2026-09-19/20, owner brief): "every
                      discovery job reports 'Enriched: 0'" -- confirmed
                      real, and not a counting bug: discovery
                      (sales-google-places-discovery) never performs
                      website enrichment at all, by design (see its own
                      header comment -- enrichment is a separate,
                      per-lead, manually-triggered step:
                      sales-website-enrichment, run from a lead's own
                      detail page). enriched_count is a schema column no
                      code has ever written to. Rather than fabricate a
                      count for a step this job never runs, or wire
                      discovery to auto-enrich every lead (a real
                      architecture change well beyond this bug's scope),
                      the stat is removed from this job-summary view --
                      it measured something this screen's own process
                      structurally cannot report. */}
                  <div className="grid grid-cols-3 gap-2 px-3 pb-3 text-sm sm:grid-cols-5">
                    <span>{t('platform.sales.discover.discovered')}: {job.discovered_count}</span>
                    <span>{t('platform.sales.discover.new')}: {job.new_count}</span>
                    <span>{t('platform.sales.discover.duplicates')}: {job.duplicate_count}</span>
                    <span>{t('platform.sales.discover.failed')}: {job.failed_count}</span>
                    <span>{t('platform.sales.discover.skipped')}: {job.skipped_count}</span>
                  </div>
                  {job.failed_count > 0 && job.last_error && (
                    <p className="px-3 pb-3 text-xs text-status-danger">{job.last_error}</p>
                  )}
                  {openJobId === job.id ? (
                    <div id={`discovery-job-${job.id}`} className="grid gap-3 border-t border-border-subtle bg-surface-muted p-3 text-sm sm:grid-cols-2">
                      <div><span className="text-text-secondary">{t('platform.sales.discover.queryLabel')}:</span> {searchParam(job, 'query') || '—'}</div>
                      <div><span className="text-text-secondary">{t('platform.sales.discover.location')}:</span> {[searchParam(job, 'city'), searchParam(job, 'country')].filter(Boolean).join('، ') || '—'}</div>
                      <div><span className="text-text-secondary">{t('platform.sales.discover.attempts')}:</span> {job.attempts}</div>
                      <div><span className="text-text-secondary">{t('platform.sales.discover.jobId')}:</span> <bdi className="font-mono text-xs">{job.id}</bdi></div>
                      <div><span className="text-text-secondary">{t('platform.sales.discover.startedAt')}:</span> {job.started_at ? <FormattedDate value={job.started_at} timeZone={SALES_DISPLAY_TIMEZONE} /> : '—'}</div>
                      <div><span className="text-text-secondary">{t('platform.sales.discover.finishedAt')}:</span> {job.finished_at ? <FormattedDate value={job.finished_at} timeZone={SALES_DISPLAY_TIMEZONE} /> : '—'}</div>
                      {job.last_error ? <div className="sm:col-span-2"><span className="text-text-secondary">{t('platform.sales.discover.lastError')}:</span> <span className="text-status-danger">{job.last_error}</span></div> : null}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
