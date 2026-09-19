// SalesCampaignsPage -- Sales Intelligence Phase 12 (ADR-054).
//
// REAL BUG FIX (2026-09-18, live-verified audit): a campaign could be
// created but had NO way to ever add a single lead to it -- the
// backend RPC (sales_add_leads_to_campaign, inserting into
// sales_campaign_leads) existed and worked correctly, but no
// component anywhere called it. Confirmed live: creating a real
// campaign produced a card with zero interactive elements besides the
// page's own "New Campaign" button -- every campaign's target_count
// was permanently stuck at 0. CampaignLeadsDialog below closes that
// gap: "Manage leads" opens a picker (reusing search_sales_leads, the
// same RPC/columns SalesLeadsPage.tsx already uses) with checkboxes,
// calling sales_add_leads_to_campaign on confirm. No backend change
// needed -- get_campaign_stats() already reads sales_campaign_leads
// correctly, so target_count starts reflecting reality the moment
// leads are actually added through this dialog.
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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog'

interface CampaignLeadCandidate {
  lead_id: string
  business_name: string
  city: string | null
  country: string | null
  status: string
  current_score: number
}

async function fetchAddableLeads(search: string): Promise<CampaignLeadCandidate[]> {
  const { data, error } = await supabase.rpc('search_sales_leads', {
    p_search: search || undefined,
    p_exclude_do_not_contact: true,
    p_limit: 50,
    p_offset: 0,
  })
  if (error) throw error
  return (data ?? []).map((r) => ({
    lead_id: r.lead_id,
    business_name: r.business_name,
    city: r.city,
    country: r.country,
    status: r.status,
    current_score: r.current_score,
  }))
}

function CampaignLeadsDialog({ campaignId }: { campaignId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const { data: leads, isLoading, isError, error } = useQuery({
    queryKey: ['sales-campaign-addable-leads', search],
    queryFn: () => fetchAddableLeads(search),
    enabled: open,
  })

  const addMutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.rpc('sales_add_leads_to_campaign', {
        p_campaign_id: campaignId,
        p_lead_ids: Array.from(selected),
      })
      if (err) throw err
    },
    onSuccess: () => {
      setSelected(new Set())
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['sales-campaign-stats', campaignId] })
    },
  })

  function toggle(leadId: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(leadId)) next.delete(leadId)
      else next.add(leadId)
      return next
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setSelected(new Set()) }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">{t('platform.sales.campaigns.manageLeads')}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[80vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('platform.sales.campaigns.manageLeads')}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input
            placeholder={t('platform.sales.campaigns.searchLeadsPlaceholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {isError ? (
            <p className="text-sm text-status-danger">{translateSupabaseError(error, t('platform.sales.campaigns.leadsLoadError'))}</p>
          ) : isLoading ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.campaigns.stats.loading')}</p>
          ) : (leads ?? []).length === 0 ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.campaigns.noLeadsFound')}</p>
          ) : (
            <div className="max-h-80 space-y-1 overflow-y-auto">
              {(leads ?? []).map((lead) => (
                <label
                  key={lead.lead_id}
                  className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-surface-hover"
                >
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={selected.has(lead.lead_id)}
                    onChange={() => toggle(lead.lead_id)}
                  />
                  <span className="flex-1">{lead.business_name}</span>
                  <span className="text-xs text-text-secondary">{[lead.city, lead.country].filter(Boolean).join(', ')}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            onClick={() => addMutation.mutate()}
            disabled={selected.size === 0 || addMutation.isPending}
          >
            {t('platform.sales.campaigns.addSelectedLeads', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

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
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>{campaign.name}</CardTitle>
        <CampaignLeadsDialog campaignId={campaign.id} />
      </CardHeader>
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
