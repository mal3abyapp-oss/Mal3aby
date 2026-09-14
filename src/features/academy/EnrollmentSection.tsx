import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// Simple activation-policy dropdown -- club_owner-scoped setting, kept
// minimal per ADR-013 ("a simple dropdown ... is sufficient").
export function ActivationPolicySetting() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const ACTIVATION_POLICY_LABELS: Record<string, string> = {
    manual: t('academy.activationPolicyLabels.manual'),
    first_payment: t('academy.activationPolicyLabels.first_payment'),
    full_payment: t('academy.activationPolicyLabels.full_payment'),
  }

  const { data: policy } = useQuery({
    queryKey: ['activation-policy', currentClubId],
    queryFn: async () => {
      const { data, error } = await supabase.from('clubs').select('subscription_activation_policy').eq('id', currentClubId!).single()
      if (error) throw error
      return data.subscription_activation_policy
    },
    enabled: !!currentClubId,
  })

  const updateMutation = useMutation({
    mutationFn: async (value: string) => {
      const { error } = await supabase.from('clubs').update({ subscription_activation_policy: value }).eq('id', currentClubId!)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['activation-policy', currentClubId] }),
  })

  return (
    <div className="flex items-center gap-3">
      <label className="text-sm font-medium text-text-secondary">{t('academy.enrollments.activationPolicy')}</label>
      <Select value={policy ?? 'first_payment'} onValueChange={(v) => updateMutation.mutate(v)}>
        <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
        <SelectContent>
          {Object.entries(ACTIVATION_POLICY_LABELS).map(([key, label]) => (
            <SelectItem key={key} value={key}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
