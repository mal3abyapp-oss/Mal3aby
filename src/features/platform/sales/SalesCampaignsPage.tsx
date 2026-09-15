// SalesCampaignsPage -- Sales Intelligence Phase 12 (ADR-054).
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ListLoadingSkeleton } from './ListLoadingSkeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormLabel } from '@/components/ui/form-label'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'

interface Campaign {
  id: string
  name: string
  description: string | null
  status: string
  created_at: string
}

async function fetchCampaigns(): Promise<Campaign[]> {
  const { data, error } = await supabase.from('sales_campaigns').select('id, name, description, status, created_at').order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

function CampaignCard({ campaign }: { campaign: Campaign }) {
  const { t } = useTranslation()
  // P3 fix: this per-card stats query had no loading/error handling --
  // a failed fetch for one campaign's stats left its stats row
  // permanently absent, indistinguishable from a brand-new campaign
  // with zero activity. Handled at the card level (not the whole page)
  // since this is a per-item query in a list.
  const statsQuery = useQuery({
    queryKey: ['sales-campaign-stats', campaign.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_campaign_stats', { p_campaign_id: campaign.id })
      if (error) throw error
      return data?.[0]
    },
  })
  const stats = statsQuery.data

  return (
    <Card>
      <CardHeader><CardTitle>{campaign.name}</CardTitle></CardHeader>
      <CardContent>
        <p className="mb-2 text-sm text-text-secondary">{campaign.description}</p>
        {statsQuery.isLoading ? (
          <p className="text-sm text-text-secondary">{t('platform.sales.campaigns.stats.loading')}</p>
        ) : statsQuery.isError ? (
          <div className="flex items-center justify-between gap-2 text-sm text-status-danger">
            <span>{translateSupabaseError(statsQuery.error, t('platform.sales.campaigns.stats.loadError'))}</span>
            <Button size="sm" variant="outline" onClick={() => void statsQuery.refetch()}>
              {t('errorState.retry')}
            </Button>
          </div>
        ) : stats && (
          <div className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-6">
            <span>{t('platform.sales.campaigns.stats.target')}: {stats.target_count}</span>
            <span>{t('platform.sales.campaigns.stats.queued')}: {stats.queued}</span>
            <span>{t('platform.sales.campaigns.stats.contacted')}: {stats.contacted}</span>
            <span>{t('platform.sales.campaigns.stats.replied')}: {stats.replied}</span>
            <span>{t('platform.sales.campaigns.stats.demos')}: {stats.demos}</span>
            <span>{t('platform.sales.campaigns.stats.won')}: {stats.won}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function SalesCampaignsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ['sales-campaigns'], queryFn: fetchCampaigns })

  const createMutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('sales_create_campaign', { p_name: name, p_description: description || '', p_criteria: {} })
      if (err) throw err
    },
    onSuccess: () => {
      setName('')
      setDescription('')
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['sales-campaigns'] })
    },
  })

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('platform.sales.campaigns.title')}
        description={t('platform.sales.campaigns.description')}
        actions={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button>{t('platform.sales.campaigns.createButton')}</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>{t('platform.sales.campaigns.createButton')}</DialogTitle></DialogHeader>
              <div className="space-y-3">
                <div>
                  <FormLabel htmlFor="campaign-name" required>{t('platform.sales.campaigns.nameLabel')}</FormLabel>
                  <Input id="campaign-name" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                  <FormLabel htmlFor="campaign-description">{t('platform.sales.campaigns.descriptionLabel')}</FormLabel>
                  <Input id="campaign-description" value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
                <Button onClick={() => createMutation.mutate()} disabled={!name || createMutation.isPending}>
                  {t('common.save')}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        }
      />

      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('platform.sales.campaigns.loadError'))} onRetry={() => refetch()} />
      ) : isLoading ? (
        <ListLoadingSkeleton />
      ) : (data ?? []).length === 0 ? (
        <p className="text-sm text-text-secondary">{t('platform.sales.campaigns.emptyTitle')}</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {(data ?? []).map((c) => (
            <CampaignCard key={c.id} campaign={c} />
          ))}
        </div>
      )}
    </div>
  )
}
