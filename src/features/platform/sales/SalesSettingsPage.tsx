// SalesSettingsPage -- Sales Intelligence Phase 2/18 (ADR-054). Shows
// each provider's CONFIGURATION_BLOCKED/connected status. Configuring a
// real credential requires creating a Supabase Vault secret first
// (outside this UI, via the Supabase dashboard/CLI -- this codebase's
// own established convention for every gateway secret, see
// PAYMENT_GATEWAY_ARCHITECTURE.md) and then attaching its vault ID
// here via set_sales_provider_secret() -- this UI never accepts or
// displays a raw secret value itself.
import { Fragment, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormLabel } from '@/components/ui/form-label'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'

interface ProviderStatus {
  provider_key: string
  enabled: boolean
  is_configured: boolean
  daily_cap: number
  config: { provider?: string; model?: string; free_tier?: boolean } | null
}

const PROVIDER_LABELS: Record<string, string> = {
  google_places: 'Google Places',
  ai_offer_generator: 'AI Offer Generator',
  website_enrichment: 'Website Enrichment',
}

async function fetchProviderStatus(): Promise<ProviderStatus[]> {
  const { data, error } = await supabase.rpc('get_sales_provider_status')
  if (error) throw error
  return (data ?? []).map((row) => ({
    ...row,
    config: (row.config ?? null) as ProviderStatus['config'],
  }))
}

export function SalesSettingsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [configuring, setConfiguring] = useState<string | null>(null)
  const [vaultId, setVaultId] = useState('')

  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ['sales-provider-status-settings'], queryFn: fetchProviderStatus })

  const configureMutation = useMutation({
    mutationFn: async (providerKey: string) => {
      const { error: err } = await supabase.rpc('set_sales_provider_secret', {
        p_provider_key: providerKey,
        p_secret_vault_id: vaultId,
        p_enabled: true,
      })
      if (err) throw err
    },
    onSuccess: () => {
      setConfiguring(null)
      setVaultId('')
      void queryClient.invalidateQueries({ queryKey: ['sales-provider-status-settings'] })
      void queryClient.invalidateQueries({ queryKey: ['sales-provider-status'] })
    },
  })

  return (
    <div className="space-y-6">
      <PageHeader title={t('platform.sales.settings.title')} description={t('platform.sales.settings.description')} />

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.settings.providersTitle')}</CardTitle></CardHeader>
        <CardContent>
          {isError ? (
            <ErrorState message={translateSupabaseError(error, t('platform.sales.settings.loadError'))} onRetry={() => refetch()} />
          ) : isLoading ? (
            <p className="text-sm text-text-secondary">{t('common.loading')}</p>
          ) : (
            <ul className="space-y-3">
              {(data ?? []).map((p) => (
                <Fragment key={p.provider_key}>
                  <li className="flex items-center justify-between border-b border-border-subtle pb-3 last:border-0">
                    <div>
                      <p className="font-medium">{PROVIDER_LABELS[p.provider_key] ?? p.provider_key}</p>
                      {p.provider_key === 'ai_offer_generator' && p.config?.provider && (
                        <p className="text-sm text-text-secondary">
                          {t('platform.sales.settings.activeProvider')}: {p.config.provider === 'groq' ? 'Groq' : p.config.provider === 'anthropic' ? 'Anthropic' : p.config.provider}
                          {p.config.model ? ` (${p.config.model})` : ''}
                          {p.config.provider === 'groq' ? ` — ${t('platform.sales.settings.freeTier')}` : ''}
                        </p>
                      )}
                      <p className="text-sm text-text-secondary">{t('platform.sales.settings.dailyCap')}: {p.daily_cap}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge
                        tone={p.is_configured ? 'success' : 'warning'}
                        label={p.is_configured ? t('platform.sales.settings.configured') : t('platform.sales.settings.notConfigured')}
                      />
                      {p.provider_key !== 'website_enrichment' && (
                        <Button size="sm" variant="outline" onClick={() => setConfiguring(p.provider_key)}>
                          {t('platform.sales.settings.configureButton')}
                        </Button>
                      )}
                    </div>
                  </li>
                  {/* AI Offer Generator: Anthropic is shown as a separate, informational
                      row -- never as a system failure just because billing isn't enabled
                      (owner decision, 2026-09-04: "Do not display Anthropic as a system
                      failure merely because the owner chose not to purchase credits"). */}
                  {p.provider_key === 'ai_offer_generator' && (
                    <li className="flex items-center justify-between border-b border-border-subtle pb-3 last:border-0 pl-4">
                      <div>
                        <p className="text-sm font-medium text-text-secondary">Anthropic ({t('platform.sales.settings.optionalProvider')})</p>
                      </div>
                      <StatusBadge
                        tone="neutral"
                        label={p.config?.provider === 'anthropic' ? t('platform.sales.settings.available') : t('platform.sales.settings.billingNotEnabled')}
                      />
                    </li>
                  )}
                </Fragment>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!configuring} onOpenChange={(open) => !open && setConfiguring(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('platform.sales.settings.configureButton')}: {configuring && (PROVIDER_LABELS[configuring] ?? configuring)}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              Create a Supabase Vault secret for this provider's API key first (via the Supabase dashboard), then paste its Vault secret UUID below.
            </p>
            <div>
              <FormLabel htmlFor="vault-id" required>Vault Secret ID</FormLabel>
              <Input id="vault-id" value={vaultId} onChange={(e) => setVaultId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" />
            </div>
            {configureMutation.isError && (
              <p className="text-sm text-status-danger">{translateSupabaseError(configureMutation.error, t('platform.sales.settings.loadError'))}</p>
            )}
            <Button onClick={() => configuring && configureMutation.mutate(configuring)} disabled={!vaultId || configureMutation.isPending}>
              {t('common.save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
