import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { translateSupabaseError } from '@/lib/errors'
import { Landmark, ShieldCheck, AlertTriangle } from 'lucide-react'

// PHASE 2 MULTI-GATEWAY ONLINE PAYMENTS -- club-owner-facing management
// UI for club_gateway_connections, replacing the legacy
// PaymentGatewaysCard (payment_gateway_configs / upsert_payment_gateway_config,
// stripe+paypal only, single-config-per-club). That table/RPC pair is
// superseded by this multi-connection model (5 providers x 2
// environments, real Vault-backed credentials, per-connection health
// tracking) -- see AGENT_ORCHESTRATION_GOVERNANCE.md / the Phase 2
// directive for the full background.
//
// RPC contracts read directly from the live database this session
// (pg_get_functiondef) -- every parameter name/order below matches the
// live functions exactly, not a guess from a spec summary:
//   list_payment_gateway_providers() -> key, display_name,
//     supported_countries, supported_currencies, supports_sandbox,
//     supports_live, supports_partial_refund, supports_native_idempotency_key
//   list_club_gateway_connections(p_club_id) -> id, provider_key,
//     provider_display_name, environment, public_key, has_secret,
//     provider_merchant_ref, enabled, is_default, last_verified_at,
//     last_verification_error, last_webhook_at, last_webhook_error,
//     last_success_at, last_failure_at, updated_at
//   connect_club_gateway(p_club_id, p_provider_key, p_environment,
//     p_public_key, p_secret, p_webhook_secret, p_provider_merchant_ref) -> uuid
//   set_club_gateway_enabled(p_connection_id, p_enabled)
//   set_club_gateway_default(p_connection_id)
//   disconnect_club_gateway(p_connection_id)
//
// SECRET DISPLAY: list_club_gateway_connections never returns a raw
// secret -- only has_secret (boolean). This component never asks for,
// stores, or displays a decrypted secret; the connect form's key/secret
// inputs are write-only (cleared from local state immediately on
// submit) and never pre-filled from a prior save.
//
// "TEST CONNECTION": no test_gateway_connection (or equivalent
// verification) RPC exists anywhere in the schema as of this session
// (confirmed via a direct pg_proc search for the pattern this
// session -- zero rows). Building a real one would mean each of the 5
// checkout-session edge functions growing a side-effect-free "verify
// only" mode (e.g. Stripe: a harmless GET to /v1/balance with the
// stored secret key; PayPal: the OAuth token fetch alone, which is
// genuinely read-only) -- real, buildable work, but out of scope for a
// pure frontend-wiring task against already-existing RPCs, and
// deliberately not faked here with a toast that doesn't verify
// anything real. Omitted; flagged as a follow-up below and in the
// final report.
//
// PER-PROVIDER VAULT-SLOT MAPPING -- read directly from each of the 5
// create-checkout-session edge functions' own header comments/logic
// this session (not guessed):
//   stripe : public_key = Publishable key   | secret_vault_id = Secret key
//   paymob : public_key = Public key        | secret_vault_id = Secret/API key                    | provider_merchant_ref = Integration ID(s), comma-separated
//   kashier: (no public_key)                | secret_vault_id = Secret Key (refund only)           | webhook_secret_vault_id = Payment API Key (session + webhook HMAC) | provider_merchant_ref = Merchant ID (MID-XXXX-XXX)
//   fawry  : (no public_key)                | secret_vault_id = Secure Hash Key (single secret)     | provider_merchant_ref = Merchant Code
//   paypal : public_key = Client ID         | secret_vault_id = Client Secret                       | provider_merchant_ref = Webhook ID

type Environment = 'sandbox' | 'live'

interface ProviderRow {
  key: string
  displayName: string
  supportedCountries: string[]
  supportedCurrencies: string[]
  supportsSandbox: boolean
  supportsLive: boolean
  supportsPartialRefund: boolean
  supportsNativeIdempotencyKey: boolean
}

interface ConnectionRow {
  id: string
  providerKey: string
  providerDisplayName: string
  environment: Environment
  publicKey: string | null
  hasSecret: boolean
  providerMerchantRef: string | null
  enabled: boolean
  isDefault: boolean
  lastVerifiedAt: string | null
  lastVerificationError: string | null
  lastWebhookAt: string | null
  lastWebhookError: string | null
  lastSuccessAt: string | null
  lastFailureAt: string | null
  updatedAt: string
}

// Field shape per provider -- drives which inputs the connect form
// shows and which RPC parameter each one maps to. See file header for
// the research trail behind this table.
interface ProviderFieldSpec {
  publicKeyLabelKey: string | null // null = provider has no public_key field
  secretLabelKey: string
  webhookSecretLabelKey: string | null // null = provider does not use this slot
  merchantRefLabelKey: string | null // null = provider does not use provider_merchant_ref
  merchantRefRequired: boolean
}

const PROVIDER_FIELD_SPECS: Record<string, ProviderFieldSpec> = {
  stripe: {
    publicKeyLabelKey: 'billing.gatewayConnections.fields.stripePublicKey',
    secretLabelKey: 'billing.gatewayConnections.fields.stripeSecretKey',
    webhookSecretLabelKey: null,
    merchantRefLabelKey: null,
    merchantRefRequired: false,
  },
  paymob: {
    publicKeyLabelKey: 'billing.gatewayConnections.fields.paymobPublicKey',
    secretLabelKey: 'billing.gatewayConnections.fields.paymobSecretKey',
    webhookSecretLabelKey: null,
    merchantRefLabelKey: 'billing.gatewayConnections.fields.paymobIntegrationIds',
    merchantRefRequired: true,
  },
  kashier: {
    publicKeyLabelKey: null,
    secretLabelKey: 'billing.gatewayConnections.fields.kashierSecretKey',
    webhookSecretLabelKey: 'billing.gatewayConnections.fields.kashierPaymentApiKey',
    merchantRefLabelKey: 'billing.gatewayConnections.fields.kashierMerchantId',
    merchantRefRequired: true,
  },
  fawry: {
    publicKeyLabelKey: null,
    secretLabelKey: 'billing.gatewayConnections.fields.fawrySecureKey',
    webhookSecretLabelKey: null,
    merchantRefLabelKey: 'billing.gatewayConnections.fields.fawryMerchantCode',
    merchantRefRequired: true,
  },
  paypal: {
    publicKeyLabelKey: 'billing.gatewayConnections.fields.paypalClientId',
    secretLabelKey: 'billing.gatewayConnections.fields.paypalClientSecret',
    webhookSecretLabelKey: null,
    merchantRefLabelKey: 'billing.gatewayConnections.fields.paypalWebhookId',
    merchantRefRequired: false,
  },
}

const DEFAULT_FIELD_SPEC: ProviderFieldSpec = {
  publicKeyLabelKey: 'billing.gatewayConnections.fields.genericPublicKey',
  secretLabelKey: 'billing.gatewayConnections.fields.genericSecretKey',
  webhookSecretLabelKey: null,
  merchantRefLabelKey: null,
  merchantRefRequired: false,
}

async function fetchProviders(): Promise<ProviderRow[]> {
  const { data, error } = await supabase.rpc('list_payment_gateway_providers')
  if (error) throw error
  return (data ?? []).map((r) => ({
    key: r.key,
    displayName: r.display_name,
    supportedCountries: r.supported_countries ?? [],
    supportedCurrencies: r.supported_currencies ?? [],
    supportsSandbox: r.supports_sandbox,
    supportsLive: r.supports_live,
    supportsPartialRefund: r.supports_partial_refund,
    supportsNativeIdempotencyKey: r.supports_native_idempotency_key,
  }))
}

async function fetchConnections(clubId: string): Promise<ConnectionRow[]> {
  const { data, error } = await supabase.rpc('list_club_gateway_connections', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    providerKey: r.provider_key,
    providerDisplayName: r.provider_display_name,
    environment: r.environment as Environment,
    publicKey: r.public_key,
    hasSecret: r.has_secret,
    providerMerchantRef: r.provider_merchant_ref,
    enabled: r.enabled,
    isDefault: r.is_default,
    lastVerifiedAt: r.last_verified_at,
    lastVerificationError: r.last_verification_error,
    lastWebhookAt: r.last_webhook_at,
    lastWebhookError: r.last_webhook_error,
    lastSuccessAt: r.last_success_at,
    lastFailureAt: r.last_failure_at,
    updatedAt: r.updated_at,
  }))
}

function ConnectGatewayDialog({ providers, canManage }: { providers: ProviderRow[]; canManage: boolean }) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [providerKey, setProviderKey] = useState<string>('')
  const [environment, setEnvironment] = useState<Environment>('sandbox')
  const [publicKey, setPublicKey] = useState('')
  const [secret, setSecret] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [merchantRef, setMerchantRef] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const selectedProvider = providers.find((p) => p.key === providerKey) ?? null
  const spec = providerKey ? (PROVIDER_FIELD_SPECS[providerKey] ?? DEFAULT_FIELD_SPEC) : null

  function resetForm() {
    setProviderKey('')
    setEnvironment('sandbox')
    setPublicKey('')
    setSecret('')
    setWebhookSecret('')
    setMerchantRef('')
    setFormError(null)
  }

  const mutation = useMutation({
    mutationFn: async () => {
      if (!currentClubId) throw new Error('no club selected')
      const { error } = await supabase.rpc('connect_club_gateway', {
        p_club_id: currentClubId,
        p_provider_key: providerKey,
        p_environment: environment,
        p_public_key: publicKey.trim() || undefined,
        p_secret: secret.trim() || undefined,
        p_webhook_secret: webhookSecret.trim() || undefined,
        p_provider_merchant_ref: merchantRef.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setOpen(false)
      resetForm()
      void queryClient.invalidateQueries({ queryKey: ['club-gateway-connections', currentClubId] })
    },
    // Secret values are cleared from local state regardless of outcome
    // -- never left sitting in a controlled input after a submit
    // attempt, successful or not.
    onError: (error) => {
      setSecret('')
      setWebhookSecret('')
      setFormError(translateSupabaseError(error, t('billing.gatewayConnections.connectError')))
    },
  })

  const canSubmit =
    !!providerKey &&
    !!secret.trim() &&
    (!spec?.merchantRefRequired || !!merchantRef.trim())

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) resetForm()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" disabled={!canManage}>
          {t('billing.gatewayConnections.connectProvider')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('billing.gatewayConnections.connectDialogTitle')}</DialogTitle>
          <DialogDescription>{t('billing.gatewayConnections.connectDialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t('billing.gatewayConnections.provider')}</label>
            <Select value={providerKey} onValueChange={(v) => { setProviderKey(v); setFormError(null) }}>
              <SelectTrigger>
                <SelectValue placeholder={t('billing.gatewayConnections.selectProvider')} />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.key} value={p.key}>{p.displayName}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedProvider && (
              <p className="text-xs text-text-secondary">
                {t('billing.gatewayConnections.supportedCurrenciesHint', {
                  currencies: selectedProvider.supportedCurrencies.join(', '),
                })}
              </p>
            )}
          </div>

          {selectedProvider && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t('billing.gatewayConnections.environment')}</label>
              <Select value={environment} onValueChange={(v) => setEnvironment(v as Environment)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectedProvider.supportsSandbox && (
                    <SelectItem value="sandbox">{t('billing.gatewayConnections.sandbox')}</SelectItem>
                  )}
                  {selectedProvider.supportsLive && (
                    <SelectItem value="live">{t('billing.gatewayConnections.live')}</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          {spec && spec.publicKeyLabelKey && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t(spec.publicKeyLabelKey)}</label>
              <Input value={publicKey} onChange={(e) => setPublicKey(e.target.value)} autoComplete="off" />
            </div>
          )}

          {spec && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t(spec.secretLabelKey)}</label>
              <Input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete="off"
                placeholder={t('billing.gatewayConnections.secretPlaceholder')}
              />
            </div>
          )}

          {spec && spec.webhookSecretLabelKey && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t(spec.webhookSecretLabelKey)}</label>
              <Input
                type="password"
                value={webhookSecret}
                onChange={(e) => setWebhookSecret(e.target.value)}
                autoComplete="off"
                placeholder={t('billing.gatewayConnections.secretPlaceholder')}
              />
            </div>
          )}

          {spec && spec.merchantRefLabelKey && (
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium">{t(spec.merchantRefLabelKey)}</label>
              <Input value={merchantRef} onChange={(e) => setMerchantRef(e.target.value)} autoComplete="off" />
            </div>
          )}

          {formError && <p className="text-sm text-status-danger">{formError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t('billing.gatewayConnections.cancel')}</Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
            {mutation.isPending ? t('billing.gatewayConnections.connecting') : t('billing.gatewayConnections.connect')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DisconnectConfirmDialog({ connection, canManage }: { connection: ConnectionRow; canManage: boolean }) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('disconnect_club_gateway', { p_connection_id: connection.id })
      if (error) throw error
    },
    onSuccess: () => {
      setOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['club-gateway-connections', currentClubId] })
    },
    onError: (error) => setFormError(translateSupabaseError(error, t('billing.gatewayConnections.disconnectError'))),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={!canManage}>
          {t('billing.gatewayConnections.disconnect')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('billing.gatewayConnections.disconnectConfirmTitle')}</DialogTitle>
          <DialogDescription>
            {t('billing.gatewayConnections.disconnectConfirmDescription', {
              provider: connection.providerDisplayName,
              environment: t(`billing.gatewayConnections.${connection.environment}`),
            })}
          </DialogDescription>
        </DialogHeader>
        {formError && <p className="text-sm text-status-danger">{formError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t('billing.gatewayConnections.cancel')}</Button>
          <Button variant="destructive" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? t('billing.gatewayConnections.disconnecting') : t('billing.gatewayConnections.disconnectConfirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConnectionCard({ connection, canManage }: { connection: ConnectionRow; canManage: boolean }) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [actionError, setActionError] = useState<string | null>(null)

  const toggleEnabledMutation = useMutation({
    mutationFn: async (nextEnabled: boolean) => {
      const { error } = await supabase.rpc('set_club_gateway_enabled', {
        p_connection_id: connection.id,
        p_enabled: nextEnabled,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      void queryClient.invalidateQueries({ queryKey: ['club-gateway-connections', currentClubId] })
    },
    // set_club_gateway_enabled's own guard: "cannot enable a connection
    // with no saved credentials" -- surfaced explicitly here rather
    // than silently failing (directive requirement).
    onError: (error) => setActionError(translateSupabaseError(error, t('billing.gatewayConnections.toggleError'))),
  })

  const setDefaultMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('set_club_gateway_default', { p_connection_id: connection.id })
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      void queryClient.invalidateQueries({ queryKey: ['club-gateway-connections', currentClubId] })
    },
    // set_club_gateway_default's own guard: "cannot set a disabled
    // connection as default -- enable it first".
    onError: (error) => setActionError(translateSupabaseError(error, t('billing.gatewayConnections.setDefaultError'))),
  })

  const hasCredentials = connection.hasSecret

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Landmark className="size-4 shrink-0 text-text-secondary" />
          <p className="font-medium">{connection.providerDisplayName}</p>
          <StatusBadge
            tone="neutral"
            label={t(`billing.gatewayConnections.${connection.environment}`)}
          />
          {connection.isDefault && (
            <StatusBadge tone="info" label={t('billing.gatewayConnections.default')} />
          )}
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge
            tone={hasCredentials ? 'success' : 'neutral'}
            label={hasCredentials ? t('billing.gatewayConnections.configured') : t('billing.gatewayConnections.notConfigured')}
          />
          <StatusBadge
            tone={connection.enabled ? 'success' : 'neutral'}
            label={connection.enabled ? t('billing.gatewayConnections.enabled') : t('billing.gatewayConnections.disabled')}
          />
        </div>
      </div>

      {(connection.lastVerificationError || connection.lastWebhookError) && (
        <div className="flex items-start gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-2 text-xs text-status-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="flex flex-col gap-0.5">
            {connection.lastVerificationError && <span>{connection.lastVerificationError}</span>}
            {connection.lastWebhookError && <span>{connection.lastWebhookError}</span>}
          </div>
        </div>
      )}

      {connection.lastSuccessAt && (
        <p className="flex items-center gap-1.5 text-xs text-text-secondary">
          <ShieldCheck className="size-3.5 shrink-0" />
          {t('billing.gatewayConnections.lastSuccessAt', { date: new Date(connection.lastSuccessAt).toLocaleString() })}
        </p>
      )}

      {actionError && <p className="text-xs text-status-danger">{actionError}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={!canManage || toggleEnabledMutation.isPending || (!connection.enabled && !hasCredentials)}
          onClick={() => toggleEnabledMutation.mutate(!connection.enabled)}
        >
          {connection.enabled ? t('billing.gatewayConnections.disableConnection') : t('billing.gatewayConnections.enableConnection')}
        </Button>
        {!connection.isDefault && (
          <Button
            size="sm"
            variant="outline"
            disabled={!canManage || !connection.enabled || setDefaultMutation.isPending}
            onClick={() => setDefaultMutation.mutate()}
          >
            {t('billing.gatewayConnections.makeDefault')}
          </Button>
        )}
        <DisconnectConfirmDialog connection={connection} canManage={canManage} />
      </div>
    </div>
  )
}

export function PaymentGatewayConnectionsCard() {
  const { t } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()

  // Matches the exact permission keys read from connect_club_gateway /
  // set_club_gateway_enabled / set_club_gateway_default /
  // disconnect_club_gateway (payment.methods.manage) and
  // list_club_gateway_connections (payment.methods.view) themselves --
  // this is UX guidance only (buttons disabled), never the real
  // enforcement boundary (the RPCs re-check independently server-side
  // regardless of what this component renders).
  const canView = currentMembership?.permissionKeys.includes('payment.methods.view') ?? false
  const canManage = currentMembership?.permissionKeys.includes('payment.methods.manage') ?? false

  const { data: providers = [], isLoading: providersLoading } = useQuery({
    queryKey: ['payment-gateway-providers'],
    queryFn: fetchProviders,
    enabled: canView,
  })

  const { data: connections = [], isLoading: connectionsLoading, error: connectionsError } = useQuery({
    queryKey: ['club-gateway-connections', currentClubId],
    queryFn: () => fetchConnections(currentClubId!),
    enabled: !!currentClubId && canView,
  })

  const currencyHint = useMemo(() => {
    if (providers.length === 0) return null
    return providers
      .map((p) => `${p.displayName}: ${p.supportedCurrencies.join(', ') || '—'}`)
      .join(' · ')
  }, [providers])

  if (!canView) {
    return null
  }

  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="text-base">{t('billing.gatewayConnections.title')}</CardTitle>
          <p className="mt-1 text-xs text-text-secondary">{t('billing.gatewayConnections.description')}</p>
        </div>
        {!providersLoading && <ConnectGatewayDialog providers={providers} canManage={canManage} />}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {currencyHint && (
          <p className="text-xs text-text-secondary">{t('billing.gatewayConnections.currencyHintPrefix')} {currencyHint}</p>
        )}

        {connectionsLoading ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : connectionsError ? (
          <p className="text-sm text-status-danger">
            {translateSupabaseError(connectionsError, t('billing.gatewayConnections.loadError'))}
          </p>
        ) : connections.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('billing.gatewayConnections.noConnections')}</p>
        ) : (
          connections.map((c) => <ConnectionCard key={c.id} connection={c} canManage={canManage} />)
        )}

        <p className="text-xs text-text-secondary/70">{t('billing.gatewayConnections.testConnectionNote')}</p>
      </CardContent>
    </Card>
  )
}
