import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { Landmark } from 'lucide-react'
import { useState } from 'react'
import { translateSupabaseError } from '@/lib/errors'

// Master Payment Directive task #88/#89: Settings -> المدفوعات.
// Admin surface for payment_gateway_configs (see
// supabase/migrations/20260817070947_payment_gateway_architecture.sql
// and src/lib/payments/PaymentGateway.ts for the full design). This
// card is deliberately honest about the current state: no live
// Stripe/PayPal account exists for this project, so every gateway
// shows as "not connected" regardless of what's toggled here --
// has_server_credentials can only ever be set by a future server-side
// setup step (never a client write, enforced both by this UI and by
// the RLS check on the table itself). Enabling a gateway here only
// stages the club's intent + public-safe key; it does not make the
// gateway usable for checkout until real credentials are configured
// server-side.

type GatewayName = 'stripe' | 'paypal'

interface GatewayConfigRow {
  gateway: GatewayName
  enabled: boolean
  publicKey: string | null
  hasServerCredentials: boolean
}

const GATEWAY_LABELS: Record<GatewayName, string> = {
  stripe: 'Stripe',
  paypal: 'PayPal',
}

const GATEWAYS: GatewayName[] = ['stripe', 'paypal']

async function fetchGatewayConfigs(clubId: string): Promise<GatewayConfigRow[]> {
  const { data, error } = await supabase
    .from('payment_gateway_configs')
    .select('gateway, enabled, public_key, has_server_credentials')
    .eq('club_id', clubId)
  if (error) throw error
  const rows = new Map((data ?? []).map((r) => [r.gateway as GatewayName, r]))
  return GATEWAYS.map((g) => {
    const r = rows.get(g)
    return {
      gateway: g,
      enabled: r?.enabled ?? false,
      publicKey: r?.public_key ?? null,
      hasServerCredentials: r?.has_server_credentials ?? false,
    }
  })
}

export function PaymentGatewaysCard() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [draftKeys, setDraftKeys] = useState<Record<GatewayName, string>>({ stripe: '', paypal: '' })
  const [formError, setFormError] = useState<string | null>(null)

  const { data: configs = [], isLoading } = useQuery({
    queryKey: ['payment-gateway-configs', currentClubId],
    queryFn: () => fetchGatewayConfigs(currentClubId!),
    enabled: !!currentClubId,
  })

  const saveMutation = useMutation({
    mutationFn: async ({ gateway, enabled, publicKey }: { gateway: GatewayName; enabled: boolean; publicKey: string | null }) => {
      const { error } = await supabase.from('payment_gateway_configs').upsert(
        {
          club_id: currentClubId!,
          gateway,
          enabled,
          public_key: publicKey,
        },
        { onConflict: 'club_id,gateway' },
      )
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-gateway-configs', currentClubId] })
      setFormError(null)
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, t('billing.paymentGatewaysCard.saveError'))),
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('billing.paymentGatewaysCard.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-text-secondary">
          {t('billing.paymentGatewaysCard.description')}
        </p>
        {formError && <p className="text-sm text-status-danger">{formError}</p>}
        {isLoading ? (
          <p className="text-sm text-text-secondary">{t('billing.paymentGatewaysCard.loading')}</p>
        ) : (
          configs.map((c) => (
            <div key={c.gateway} className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Landmark className="size-4 shrink-0 text-text-secondary" />
                  <p className="font-medium">{GATEWAY_LABELS[c.gateway]}</p>
                </div>
                <StatusBadge
                  tone={c.hasServerCredentials ? 'success' : 'neutral'}
                  label={c.hasServerCredentials ? t('billing.paymentGatewaysCard.connected') : t('billing.paymentGatewaysCard.notConnected')}
                />
              </div>
              <div className="flex flex-col gap-2 md:flex-row md:items-center">
                <Input
                  className="md:flex-1"
                  placeholder={c.gateway === 'stripe' ? 'Publishable key (pk_...)' : 'Client ID'}
                  value={draftKeys[c.gateway] || c.publicKey || ''}
                  onChange={(e) => setDraftKeys((prev) => ({ ...prev, [c.gateway]: e.target.value }))}
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={saveMutation.isPending}
                    onClick={() =>
                      saveMutation.mutate({
                        gateway: c.gateway,
                        enabled: !c.enabled,
                        publicKey: draftKeys[c.gateway] || c.publicKey,
                      })
                    }
                  >
                    {c.enabled ? t('billing.paymentGatewaysCard.disable') : t('billing.paymentGatewaysCard.enable')}
                  </Button>
                  <Button
                    size="sm"
                    disabled={saveMutation.isPending}
                    onClick={() =>
                      saveMutation.mutate({
                        gateway: c.gateway,
                        enabled: c.enabled,
                        publicKey: draftKeys[c.gateway] || null,
                      })
                    }
                  >
                    {t('billing.paymentGatewaysCard.saveKey')}
                  </Button>
                </div>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
