import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
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
import { translateSupabaseError } from '@/lib/errors'
import { ProductThumb } from '@/features/shop/shop-media'
import { Upload, X } from 'lucide-react'

// COMMERCIAL MODULE (2026-08-26) -- Shop settings: club-owner-controlled
// module activation (directive Section 3 -- separate from platform
// entitlement, which lives on Platform Clubs/Club Detail, not here) and
// inventory location management.
interface LocationRow { locationId: string; kind: string; branchId: string | null; name: string; status: string }

async function fetchLocations(clubId: string): Promise<LocationRow[]> {
  const { data, error } = await supabase.rpc('list_shop_inventory_locations', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({ locationId: r.location_id, kind: r.kind, branchId: r.branch_id, name: r.name, status: r.status }))
}

// Acceptance-sweep fix (2026-08-30): this page's own copy has always
// claimed "Branch locations are set up automatically" (locationsHint
// below), but nothing anywhere in the codebase ever created one --
// manage_branch() never touches shop_inventory_locations, and
// activating the Shop module doesn't either. Confirmed live: a club
// with a real, active branch (created before Shop existed -- true for
// every club, since Shop is a later addition) had zero inventory
// locations and the "Add location" form only ever offered "Warehouse"
// as a kind, with no way to create a branch-linked one -- Receive
// stock, Sell, and Inventory were all genuinely unusable, the exact
// core Commerce path this module exists for. Reusing the existing
// direct-insert pattern this page already uses for the warehouse path
// (RLS already permits it: inventory.receive + shop module active),
// this fetches active branches and offers one real button per branch
// that doesn't yet have a location, finally making the page's own
// claim true instead of fixing the copy to describe the gap.
interface BranchRow { id: string; name: string }
async function fetchBranchesForLocations(clubId: string): Promise<BranchRow[]> {
  const { data, error } = await supabase.from('branches').select('id, name').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

// COMMERCE PRO C4 (2026-08-28) -- Club branding / print settings.
// Wires the previously-unused clubs.logo_url/tax_info/invoice_settings
// columns (confirmed live + confirmed unused anywhere in the app before
// this phase -- see COMMERCE_PRO_UPGRADE_PLAN.md Section 4/14) into a
// real settings form, gated on the new shop.settings.manage permission.
// Read via get_shop_print_settings (shop.view -- any staff can preview
// what's configured), written via update_shop_print_settings
// (shop.settings.manage -- only a club owner by default). See
// COMMERCE_C4_INVOICES_RECEIPTS_REPORT.md for the exact jsonb shape
// chosen for tax_info/invoice_settings.
interface PrintSettings {
  logoUrl: string
  taxNumber: string
  commercialRegistration: string
  tradingNameAr: string
  tradingNameEn: string
  address: string
  phone: string
  footerNote: string
  returnPolicy: string
}

const EMPTY_PRINT_SETTINGS: PrintSettings = {
  logoUrl: '', taxNumber: '', commercialRegistration: '', tradingNameAr: '', tradingNameEn: '',
  address: '', phone: '', footerNote: '', returnPolicy: '',
}

async function fetchPrintSettings(clubId: string): Promise<PrintSettings> {
  const { data, error } = await supabase.rpc('get_shop_print_settings', { p_club_id: clubId }).maybeSingle()
  if (error) throw error
  if (!data) return EMPTY_PRINT_SETTINGS
  return {
    logoUrl: data.logo_url ?? '',
    taxNumber: data.tax_number ?? '',
    commercialRegistration: data.commercial_registration ?? '',
    tradingNameAr: data.trading_name_ar ?? '',
    tradingNameEn: data.trading_name_en ?? '',
    address: data.address ?? '',
    phone: data.phone ?? '',
    footerNote: data.footer_note ?? '',
    returnPolicy: data.return_policy ?? '',
  }
}

const LOGO_ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const LOGO_MAX_BYTES = 2 * 1024 * 1024

async function uploadClubLogo(clubId: string, file: File): Promise<string> {
  const ext = file.name.split('.').pop() ?? 'jpg'
  const path = `${clubId}/branding/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const { error } = await supabase.storage.from('club-branding').upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw error
  const { data } = supabase.storage.from('club-branding').getPublicUrl(path)
  return data.publicUrl
}

// Real gap found in live QA (2026-08-30): this page's own header
// comment (below, unchanged) always claimed to own "club-owner-
// controlled module activation", but no such control was ever built
// here -- the only way to turn Shop off/on was a raw SQL update or a
// Platform Owner action. set_club_module_active()'s live permission
// check already allows any holder of club.update on this club (the
// same permission every other control on this page is gated on), so
// this needed a UI, not a backend change. Deactivation is real and
// immediate (blocks new sales/inventory writes at the RPC layer, per
// _shop_module_active() -- unchanged, already existed), so it gets
// the same "type-to-understand, then a second explicit click" shape
// as other real-consequence actions in this codebase, without
// introducing a new dialog primitive: an inline warning that expands
// before the actual confirm button appears.
function ShopModuleStatusSection() {
  const { t } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()
  const queryClient = useQueryClient()
  const canManage = currentMembership?.permissionKeys.includes('club.update') ?? false
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setActiveMutation = useMutation({
    mutationFn: async (active: boolean) => {
      const { error: err } = await supabase.rpc('set_club_module_active', {
        p_club_id: currentClubId as string,
        p_module_key: 'shop',
        p_active: active,
      })
      if (err) throw err
    },
    onSuccess: () => {
      setError(null)
      setConfirming(false)
      // Deactivating flips the RequireShopModule guard on this exact
      // route -- invalidate its query key too so the change is
      // reflected immediately, not just on the next hard navigation.
      void queryClient.invalidateQueries({ queryKey: ['shop-module-state', currentClubId] })
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.settings.moduleStatusError'))),
  })

  if (!canManage) return null

  return (
    <section className="rounded-md border border-border p-4">
      <h2 className="mb-1 text-base font-semibold">{t('shop.settings.moduleStatusTitle')}</h2>
      <p className="mb-3 text-xs text-text-secondary">{t('shop.settings.moduleStatusActiveHint')}</p>

      {!confirming ? (
        <Button variant="outline" size="sm" className="text-status-danger" onClick={() => setConfirming(true)}>
          {t('shop.settings.deactivateModule')}
        </Button>
      ) : (
        <div className="flex flex-col gap-3 rounded-md border border-status-danger/30 bg-status-danger/5 p-3">
          <p className="text-sm text-text-primary">{t('shop.settings.deactivateModuleConfirm')}</p>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="border-status-danger text-status-danger hover:bg-status-danger/10"
              disabled={setActiveMutation.isPending}
              onClick={() => setActiveMutation.mutate(false)}
            >
              {setActiveMutation.isPending ? t('shop.settings.saving') : t('shop.settings.deactivateModule')}
            </Button>
            <Button size="sm" variant="ghost" disabled={setActiveMutation.isPending} onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-status-danger">{error}</p>}
    </section>
  )
}

function ShopPrintSettingsSection() {
  const { t } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()
  const queryClient = useQueryClient()
  const canManage = !!currentMembership?.permissionKeys.includes('shop.settings.manage')
  const [form, setForm] = useState<PrintSettings>(EMPTY_PRINT_SETTINGS)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [logoUploading, setLogoUploading] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const { data: settings, isLoading } = useQuery({
    queryKey: ['shop-print-settings', currentClubId],
    queryFn: () => fetchPrintSettings(currentClubId as string),
    enabled: !!currentClubId,
  })

  // Loaded settings populate the editable form once fetched -- not on
  // every re-render, so an in-progress edit is never clobbered by a
  // background refetch (e.g. after a successful save invalidates this
  // same query key).
  useEffect(() => {
    if (settings) setForm(settings)
  }, [settings])

  async function handleLogoFile(file: File) {
    if (!LOGO_ACCEPTED_TYPES.includes(file.type)) { setLogoError(t('shop.media.invalidType')); return }
    if (file.size > LOGO_MAX_BYTES) { setLogoError(t('shop.media.tooLarge')); return }
    setLogoError(null)
    setLogoUploading(true)
    try {
      const url = await uploadClubLogo(currentClubId as string, file)
      setForm((f) => ({ ...f, logoUrl: url }))
    } catch (err) {
      setLogoError(translateSupabaseError(err, t('shop.media.uploadError')))
    } finally {
      setLogoUploading(false)
    }
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('update_shop_print_settings', {
        p_club_id: currentClubId as string,
        p_logo_url: form.logoUrl || undefined,
        p_tax_number: form.taxNumber || undefined,
        p_commercial_registration: form.commercialRegistration || undefined,
        p_trading_name_ar: form.tradingNameAr || undefined,
        p_trading_name_en: form.tradingNameEn || undefined,
        p_address: form.address || undefined,
        p_phone: form.phone || undefined,
        p_footer_note: form.footerNote || undefined,
        p_return_policy: form.returnPolicy || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setSaveError(null)
      setSavedAt(Date.now())
      void queryClient.invalidateQueries({ queryKey: ['shop-print-settings', currentClubId] })
    },
    onError: (err) => setSaveError(translateSupabaseError(err, t('shop.settings.printSettingsSaveError'))),
  })

  if (isLoading) return null

  return (
    <section className="rounded-md border border-border p-4">
      <h2 className="mb-1 text-base font-semibold">{t('shop.settings.printSettingsTitle')}</h2>
      <p className="mb-3 text-xs text-text-secondary">{t('shop.settings.printSettingsHint')}</p>

      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <ProductThumb src={form.logoUrl || null} alt="" className="size-16 shrink-0 rounded-md border border-border" />
          {canManage && (
            <div className="flex flex-col gap-1.5">
              <label className="w-fit">
                <input
                  type="file"
                  accept={LOGO_ACCEPTED_TYPES.join(',')}
                  className="hidden"
                  disabled={logoUploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0]
                    if (file) void handleLogoFile(file)
                    e.target.value = ''
                  }}
                />
                <span className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-muted">
                  <Upload className="size-3.5" aria-hidden="true" />
                  {logoUploading ? t('shop.media.uploading') : form.logoUrl ? t('shop.media.replaceImage') : t('shop.media.uploadImage')}
                </span>
              </label>
              {form.logoUrl && (
                <Button type="button" variant="ghost" size="sm" className="w-fit text-status-danger" onClick={() => setForm((f) => ({ ...f, logoUrl: '' }))}>
                  <X className="me-1 size-3.5" aria-hidden="true" />
                  {t('shop.media.removeImage')}
                </Button>
              )}
              {logoError && <p role="alert" className="text-xs text-status-danger">{logoError}</p>}
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.settings.tradingNameAr')}</label>
            <Input value={form.tradingNameAr} disabled={!canManage} onChange={(e) => setForm((f) => ({ ...f, tradingNameAr: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.settings.tradingNameEn')}</label>
            <Input value={form.tradingNameEn} disabled={!canManage} onChange={(e) => setForm((f) => ({ ...f, tradingNameEn: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.settings.address')}</label>
            <Input value={form.address} disabled={!canManage} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.settings.phone')}</label>
            <Input value={form.phone} disabled={!canManage} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.settings.taxNumber')}</label>
            <Input value={form.taxNumber} disabled={!canManage} onChange={(e) => setForm((f) => ({ ...f, taxNumber: e.target.value }))} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('shop.settings.commercialRegistration')}</label>
            <Input value={form.commercialRegistration} disabled={!canManage} onChange={(e) => setForm((f) => ({ ...f, commercialRegistration: e.target.value }))} />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.settings.footerNote')}</label>
          <textarea
            className="min-h-16 rounded-md border border-border bg-background p-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            value={form.footerNote}
            disabled={!canManage}
            onChange={(e) => setForm((f) => ({ ...f, footerNote: e.target.value }))}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('shop.settings.returnPolicy')}</label>
          <textarea
            className="min-h-16 rounded-md border border-border bg-background p-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
            value={form.returnPolicy}
            disabled={!canManage}
            onChange={(e) => setForm((f) => ({ ...f, returnPolicy: e.target.value }))}
          />
        </div>

        {!canManage && (
          <p className="text-xs text-text-secondary">{t('shop.settings.printSettingsReadOnlyHint')}</p>
        )}
        {canManage && (
          <div className="flex items-center gap-2">
            <Button disabled={saveMutation.isPending} onClick={() => { setSavedAt(null); saveMutation.mutate() }}>
              {saveMutation.isPending ? t('shop.settings.saving') : t('shop.settings.save')}
            </Button>
            {savedAt && <span className="text-xs text-status-success">{t('shop.settings.saved')}</span>}
          </div>
        )}
        {saveError && <p role="alert" className="text-sm text-status-danger">{saveError}</p>}
      </div>
    </section>
  )
}

export function ShopSettingsPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [newLocationName, setNewLocationName] = useState('')
  const [newLocationKind, setNewLocationKind] = useState('warehouse')
  const [error, setError] = useState<string | null>(null)

  const { data: locations = [] } = useQuery({
    queryKey: ['shop-settings-locations', currentClubId],
    queryFn: () => fetchLocations(currentClubId as string),
    enabled: !!currentClubId,
  })

  const { data: branches = [] } = useQuery({
    queryKey: ['shop-settings-branches', currentClubId],
    queryFn: () => fetchBranchesForLocations(currentClubId as string),
    enabled: !!currentClubId,
  })

  const branchIdsWithLocation = new Set(locations.map((l) => l.branchId).filter((id): id is string => !!id))
  const branchesMissingLocation = branches.filter((b) => !branchIdsWithLocation.has(b.id))

  const createLocationMutation = useMutation({
    mutationFn: async () => {
      const { error: err } = await supabase.from('shop_inventory_locations').insert({
        club_id: currentClubId as string, kind: newLocationKind, name: newLocationName,
      })
      if (err) throw err
    },
    onSuccess: () => {
      setNewLocationName('')
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['shop-settings-locations'] })
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.settings.locationCreateError'))),
  })

  const createBranchLocationMutation = useMutation({
    mutationFn: async (branch: BranchRow) => {
      const { error: err } = await supabase.from('shop_inventory_locations').insert({
        club_id: currentClubId as string, kind: 'branch', branch_id: branch.id, name: branch.name,
      })
      if (err) throw err
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: ['shop-settings-locations'] })
    },
    onError: (err) => setError(translateSupabaseError(err, t('shop.settings.locationCreateError'))),
  })

  return (
    <div>
      <PageHeader title={t('shop.settings.title')} description={t('shop.settings.description')} />

      <div className="flex flex-col gap-6">
        <ShopModuleStatusSection />

        <section className="rounded-md border border-border p-4">
          <h2 className="mb-3 text-base font-semibold">{t('shop.settings.locationsTitle')}</h2>
          <div className="flex flex-col gap-2">
            {locations.map((l) => (
              <div key={l.locationId} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                <span>{l.name}</span>
                <StatusBadge tone="neutral" label={t(`shop.settings.locationKind.${l.kind}`, { defaultValue: l.kind })} />
              </div>
            ))}
            {locations.length === 0 && <p className="text-sm text-text-secondary">{t('shop.settings.noLocationsYet')}</p>}
          </div>

          {branchesMissingLocation.length > 0 && (
            <div className="mt-3 flex flex-col gap-2 rounded-md border border-status-warning/40 bg-status-warning/5 p-3">
              <p className="text-sm text-status-warning">{t('shop.settings.branchesMissingLocationHint')}</p>
              {branchesMissingLocation.map((b) => (
                <div key={b.id} className="flex items-center justify-between gap-2 text-sm">
                  <span>{b.name}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={createBranchLocationMutation.isPending}
                    onClick={() => createBranchLocationMutation.mutate(b)}
                  >
                    {t('shop.settings.setUpBranchLocation')}
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <Input placeholder={t('shop.settings.locationNamePlaceholder')} value={newLocationName} onChange={(e) => setNewLocationName(e.target.value)} className="max-w-xs" />
            <Select value={newLocationKind} onValueChange={setNewLocationKind}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="warehouse">{t('shop.settings.locationKind.warehouse')}</SelectItem>
              </SelectContent>
            </Select>
            <Button disabled={!newLocationName || createLocationMutation.isPending} onClick={() => createLocationMutation.mutate()}>
              {t('shop.settings.addLocation')}
            </Button>
          </div>
          {error && <p role="alert" className="mt-2 text-sm text-status-danger">{error}</p>}
          <p className="mt-2 text-xs text-text-secondary">{t('shop.settings.locationsHint')}</p>
        </section>

        <ShopPrintSettingsSection />
      </div>
    </div>
  )
}
