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
import { Input } from '@/components/ui/input'
import { FormLabel } from '@/components/ui/form-label'
import { StatusBadge } from '@/components/ui/status-badge'
import { FormattedDate } from '@/components/ui/formatted-date'
import { SALES_DISPLAY_TIMEZONE } from './salesTimeZone'

interface DiscoveryJob {
  id: string
  status: string
  discovered_count: number
  new_count: number
  duplicate_count: number
  enriched_count: number
  failed_count: number
  skipped_count: number
  created_at: string
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
    .select('id, status, discovered_count, new_count, duplicate_count, enriched_count, failed_count, skipped_count, created_at')
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

export function SalesDiscoverPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [query, setQuery] = useState('')
  const [country, setCountry] = useState('EG')
  const [city, setCity] = useState('')
  const [manualName, setManualName] = useState('')
  const [manualPhone, setManualPhone] = useState('')
  const [manualWebsite, setManualWebsite] = useState('')

  const jobsQuery = useQuery({ queryKey: ['sales-discovery-jobs-recent'], queryFn: fetchRecentJobs, refetchInterval: 10_000 })
  const providerQuery = useQuery({ queryKey: ['sales-provider-status'], queryFn: fetchProviderStatus })

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
        p_business_type: null,
        p_place_id: null,
        p_website: manualWebsite || null,
        p_phone: manualPhone || null,
        p_email: null,
        p_country: country || null,
        p_city: city || null,
        p_area: null,
        p_address: null,
        p_lat: null,
        p_lng: null,
        p_rating: null,
        p_review_count: null,
      })
      if (error) throw error
      return data?.[0]
    },
    onSuccess: (result) => {
      if (result?.lead_id) navigate(`/platform/sales/leads/${result.lead_id}`)
    },
  })

  return (
    <div className="space-y-6">
      <PageHeader title={t('platform.sales.discover.title')} description={t('platform.sales.discover.description')} />

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.discover.sourceLabel')}: Google Places</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {providerQuery.data && !googlePlacesStatus?.is_configured ? (
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
              <FormLabel htmlFor="manual-phone">{t('platform.sales.leadProfile.contact')}</FormLabel>
              <Input id="manual-phone" value={manualPhone} onChange={(e) => setManualPhone(e.target.value)} />
            </div>
            <div>
              <FormLabel htmlFor="manual-website">Website</FormLabel>
              <Input id="manual-website" value={manualWebsite} onChange={(e) => setManualWebsite(e.target.value)} />
            </div>
          </div>
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
            <p className="text-sm text-text-secondary">{t('common.loading')}</p>
          ) : (jobsQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.discover.noJobs')}</p>
          ) : (
            <div className="space-y-3">
              {(jobsQuery.data ?? []).map((job) => (
                <div key={job.id} className="rounded-md border border-border-subtle p-3">
                  <div className="flex items-center justify-between">
                    <StatusBadge tone={jobStatusTone(job.status)} label={job.status} />
                    <FormattedDate value={job.created_at} timeZone={SALES_DISPLAY_TIMEZONE} className="text-sm text-text-secondary" />
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
                    <span>{t('platform.sales.discover.discovered')}: {job.discovered_count}</span>
                    <span>{t('platform.sales.discover.new')}: {job.new_count}</span>
                    <span>{t('platform.sales.discover.duplicates')}: {job.duplicate_count}</span>
                    <span>{t('platform.sales.discover.enriched')}: {job.enriched_count}</span>
                    <span>{t('platform.sales.discover.failed')}: {job.failed_count}</span>
                    <span>{t('platform.sales.discover.skipped')}: {job.skipped_count}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
