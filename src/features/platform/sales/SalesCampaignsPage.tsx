// SalesCampaignsPage -- Sales Intelligence Phase 12 (ADR-054).
import { useState } from 'react'
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
        {stats && (
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
      const { error: err } = await supabase.rpc('sales_create_campaign', { p_name: name, p_description: description || null, p_criteria: {} })
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
        <p className="text-sm text-text-secondary">{t('common.loading')}</p>
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
