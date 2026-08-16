import { useTranslation } from 'react-i18next'
import { Globe } from 'lucide-react'
import { useDirection } from '@/app/providers/DirectionProvider'
import { cn } from '@/lib/utils'

// Gate 10 — the language switcher Doc 3 requires. A single small
// toggle, not a settings sub-page — flips both the active i18next
// language and the document direction in one click, no reload (see
// DirectionProvider.setLocale()).
export function LanguageSwitcher({ className }: { className?: string }) {
  const { t } = useTranslation()
  const { locale, setLocale } = useDirection()

  return (
    <button
      type="button"
      onClick={() => setLocale(locale === 'ar' ? 'en' : 'ar')}
      className={cn('flex items-center gap-1.5 text-sm text-text-secondary hover:text-accent-foreground', className)}
      aria-label={t('language.label')}
    >
      <Globe className="size-4" />
      {locale === 'ar' ? t('language.english') : t('language.arabic')}
    </button>
  )
}
