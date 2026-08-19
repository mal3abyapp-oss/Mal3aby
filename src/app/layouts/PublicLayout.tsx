import { Link, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { MessageCircle, Mail, Phone } from 'lucide-react'
import { LanguageSwitcher } from '@/components/ui/language-switcher'

// Public marketing site shell — see docs/ARCHITECTURE.md#public-website--layout-strategy
// and docs/DESIGN_SYSTEM.md#public-website-visual-system.
// No authentication required for anything rendered inside this layout.
export function PublicLayout() {
  const { t } = useTranslation()

  return (
    <div className="flex min-h-screen flex-col bg-page-bg">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-lg font-bold text-text-primary">
            ملعبي <span className="text-text-secondary">| Mal3aby</span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm font-medium text-text-secondary md:flex">
            <Link to="/" className="hover:text-text-primary">{t('publicSite.nav.home')}</Link>
            <a href="/#features" className="hover:text-text-primary">{t('publicSite.nav.features')}</a>
            <Link to="/pricing" className="hover:text-text-primary">{t('publicSite.nav.pricing')}</Link>
            <Link to="/contact" className="hover:text-text-primary">{t('publicSite.nav.contact')}</Link>
          </nav>
          <div className="flex items-center gap-3">
            <LanguageSwitcher />
            <Button variant="ghost" size="sm" asChild>
              <Link to="/login">{t('publicSite.nav.login')}</Link>
            </Button>
            <Button size="sm" className="bg-accent text-accent-foreground hover:bg-accent/90" asChild>
              <Link to="/signup">{t('publicSite.nav.startFree')}</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1">
        <Outlet />
      </main>

      <footer className="border-t border-border bg-dark-base text-white">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 px-4 py-10 md:grid-cols-4">
          <div>
            <p className="font-bold">ملعبي | Mal3aby</p>
            <p className="mt-2 text-sm text-white/60">{t('publicSite.footer.tagline')}</p>
          </div>
          <div className="flex flex-col gap-2 text-sm text-white/70">
            <Link to="/">{t('publicSite.nav.home')}</Link>
            <a href="/#features">{t('publicSite.nav.features')}</a>
            <Link to="/pricing">{t('publicSite.nav.pricing')}</Link>
            <Link to="/contact">{t('publicSite.nav.contact')}</Link>
          </div>
          <div className="flex flex-col gap-2 text-sm text-white/70">
            <Link to="/terms">{t('publicSite.nav.terms')}</Link>
            <Link to="/privacy">{t('publicSite.nav.privacy')}</Link>
          </div>
          <div className="flex flex-col gap-2 text-sm text-white/70">
            <span className="flex items-center gap-2">
              <Mail className="size-4" /> hello@mala3by.app
            </span>
            <span className="flex items-center gap-2">
              <Phone className="size-4" /> +20 100 000 0000
            </span>
            <a
              href="https://wa.me/201000000000"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-2 hover:text-white"
            >
              <MessageCircle className="size-4" /> {t('publicSite.nav.whatsapp')}
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
