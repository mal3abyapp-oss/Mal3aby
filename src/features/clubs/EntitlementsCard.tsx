import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
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
import { AlertTriangle } from 'lucide-react'

// Gate 13 (Commercial Entitlements phase, task #52): the migration/
// enforcement work for branch/field/academy limits was already built and
// verified in an earlier session; this wires the missing frontend piece --
// showing real usage against the club's actual commercial limits, and
// letting an owner/manager request an upgrade when a limit is reached.
// Single source of truth: reads commercial_entitlements_usage, the same
// view request_commercial_upgrade() itself computes current_usage from --
// this card never recomputes branch/field/academy counts independently.

interface UsageRow {
  club_id: string | null
  club_name: string | null
  branch_limit: number | null
  branches_used: number | null
  field_limit: number | null
  fields_used: number | null
  academy_limit: number | null
  academy_used: number | null
}

interface LimitDef {
  key: 'branch_limit' | 'field_limit' | 'academy_limit'
  label: string
  limitField: 'branch_limit' | 'field_limit' | 'academy_limit'
  usedField: 'branches_used' | 'fields_used' | 'academy_used'
}

const LIMITS: LimitDef[] = [
  { key: 'branch_limit', label: 'الفروع', limitField: 'branch_limit', usedField: 'branches_used' },
  { key: 'field_limit', label: 'الملاعب', limitField: 'field_limit', usedField: 'fields_used' },
  { key: 'academy_limit', label: 'برامج الأكاديمية', limitField: 'academy_limit', usedField: 'academy_used' },
]

async function fetchUsage(clubId: string): Promise<UsageRow | null> {
  const { data, error } = await supabase
    .from('commercial_entitlements_usage')
    .select('*')
    .eq('club_id', clubId)
    .maybeSingle()
  if (error) throw error
  return data
}

function UpgradeRequestDialog({ limitType, label }: { limitType: LimitDef['key']; label: string }) {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('request_commercial_upgrade', {
        p_club_id: currentClubId as string,
        p_limit_type: limitType,
        p_note: note.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setOpen(false)
      setNote('')
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['commercial-upgrade-requests', currentClubId] })
    },
    onError: (error) => setFormError(translateSupabaseError(error, 'تعذّر إرسال طلب الترقية.')),
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">طلب زيادة الحد</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>طلب زيادة حد {label}</DialogTitle>
          <DialogDescription>
            سيصل هذا الطلب لفريق منصة ملعبي للمراجعة. الحد الحالي والاستخدام الحالي يُرفقان تلقائيًا بالطلب.
          </DialogDescription>
        </DialogHeader>
        <textarea
          className="min-h-20 rounded-md border border-border bg-background p-2 text-sm"
          placeholder="أي تفاصيل إضافية تريد إضافتها (اختياري)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
        />
        {formError && <p className="text-sm text-status-danger">{formError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>إلغاء</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending}>
            {mutation.isPending ? 'جارٍ الإرسال...' : 'إرسال الطلب'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

async function fetchPendingRequests(clubId: string) {
  const { data, error } = await supabase
    .from('commercial_upgrade_requests')
    .select('id, limit_type, status, created_at')
    .eq('club_id', clubId)
    .eq('status', 'pending')
  if (error) throw error
  return data
}

const LIMIT_TYPE_LABELS: Record<string, string> = {
  branch_limit: 'الفروع',
  field_limit: 'الملاعب',
  academy_limit: 'برامج الأكاديمية',
}

export function EntitlementsCard() {
  const { currentClubId, currentMembership } = useAuth()
  const isOwnerOrManager = currentMembership?.roleKey === 'club_owner' || currentMembership?.roleKey === 'club_manager'

  const { data, isLoading } = useQuery({
    queryKey: ['commercial-entitlements-usage', currentClubId],
    queryFn: () => fetchUsage(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: pendingRequests } = useQuery({
    queryKey: ['commercial-upgrade-requests', currentClubId],
    queryFn: () => fetchPendingRequests(currentClubId!),
    enabled: !!currentClubId && isOwnerOrManager,
  })

  const pendingTypes = new Set((pendingRequests ?? []).map((r) => r.limit_type))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">حدود الخطة التجارية</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !data ? (
          <p className="text-sm text-text-secondary">لا توجد حدود تجارية مُعرّفة لهذا النادي.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {LIMITS.map((def) => {
              const limit = data[def.limitField]
              const used = data[def.usedField] ?? 0
              const unlimited = limit === null
              const atOrOverLimit = !unlimited && used >= limit
              const nearLimit = !unlimited && !atOrOverLimit && used >= limit * 0.8
              const hasPendingRequest = pendingTypes.has(def.key)

              return (
                <div key={def.key} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium">{def.label}</span>
                    <span className="text-sm text-text-secondary tabular-nums">
                      {used} {unlimited ? '(بلا حد)' : `/ ${limit}`}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {atOrOverLimit && (
                      <StatusBadge tone="danger" label="تم بلوغ الحد" />
                    )}
                    {nearLimit && (
                      <StatusBadge tone="warning" label="قارب على الاكتمال" />
                    )}
                    {isOwnerOrManager && atOrOverLimit && (
                      hasPendingRequest ? (
                        <StatusBadge tone="neutral" label="طلب الترقية قيد المراجعة" />
                      ) : (
                        <UpgradeRequestDialog limitType={def.key} label={def.label} />
                      )
                    )}
                  </div>
                </div>
              )
            })}
            {pendingRequests && pendingRequests.length > 0 && (
              <div className="mt-1 flex items-start gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm text-status-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  لديك طلب ترقية قيد المراجعة لـ: {pendingRequests.map((r) => LIMIT_TYPE_LABELS[r.limit_type] ?? r.limit_type).join('، ')}.
                </span>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
