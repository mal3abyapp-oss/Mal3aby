import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { ShieldAlert } from 'lucide-react'
import { useAuth } from '@/app/providers/AuthProvider'
import { Button } from '@/components/ui/button'

// MASTER ADMIN / PLATFORM SUPPORT CONTEXT (2026-08-26) -- directive
// Section 4/19: this banner must be persistent (rendered on every /app
// page, not just some), visually distinct from a normal club session
// (never a plain card -- a full-width colored bar), and always carry an
// explicit Exit action. It is the single most important human-error
// protection in this whole feature: a Platform Owner must never be able
// to forget which club they are currently modifying.
export function MasterAdminBanner() {
  const { t, i18n } = useTranslation()
  const { supportSession, endSupportSession } = useAuth()
  const navigate = useNavigate()

  const exitMutation = useMutation({
    mutationFn: () => endSupportSession(),
    onSuccess: () => navigate('/platform/clubs', { replace: true }),
  })

  if (!supportSession) return null

  const modeLabel = supportSession.mode === 'manage'
    ? t('masterAdmin.banner.modeManage')
    : t('masterAdmin.banner.modeView')

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-2 border-b-2 border-amber-700 bg-amber-500 px-4 py-2.5 text-sm font-medium text-amber-950"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ShieldAlert className="size-5 shrink-0" />
        <span className="font-bold">{t('masterAdmin.banner.title')}</span>
        <span className="hidden sm:inline">—</span>
        <span>
          {t('masterAdmin.banner.managing', {
            club: i18n.language === 'en' ? supportSession.clubName : supportSession.clubName,
          })}
        </span>
        <span className="rounded-full bg-amber-950/10 px-2 py-0.5 text-xs font-semibold">{modeLabel}</span>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="border-amber-950/30 bg-amber-950/5 text-amber-950 hover:bg-amber-950/15"
        disabled={exitMutation.isPending}
        onClick={() => exitMutation.mutate()}
      >
        {exitMutation.isPending ? t('masterAdmin.banner.exiting') : t('masterAdmin.banner.exit')}
      </Button>
    </div>
  )
}
