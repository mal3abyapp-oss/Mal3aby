import { useTranslation } from 'react-i18next'

// Initial usable V1 legal content -- accurate to what Mal3aby actually
// stores and how (Supabase-hosted, RLS-isolated multi-tenant data), not
// over-engineered. Replaces the placeholder found during the Final
// Release Gate (2026-08-15). Should be reviewed by qualified legal
// counsel before the public production launch (Phase 18) if the business
// wants a fully binding policy -- this is a good-faith initial version.
export function PrivacyPage() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-2xl font-bold text-text-primary">{t('publicSite.privacy.title')}</h1>
      <p className="mt-2 text-sm text-text-secondary">{t('publicSite.privacy.lastUpdated')}</p>

      <div className="mt-6 flex flex-col gap-6 text-text-secondary">
        <section>
          <h2 className="text-lg font-semibold text-text-primary">{t('publicSite.privacy.section1.title')}</h2>
          <p className="mt-2">
            {t('publicSite.privacy.section1.body')}
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">{t('publicSite.privacy.section2.title')}</h2>
          <p className="mt-2">
            {t('publicSite.privacy.section2.body')}
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">{t('publicSite.privacy.section3.title')}</h2>
          <p className="mt-2">
            {t('publicSite.privacy.section3.body')}
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">{t('publicSite.privacy.section4.title')}</h2>
          <p className="mt-2">
            {t('publicSite.privacy.section4.body')}
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">{t('publicSite.privacy.section5.title')}</h2>
          <p className="mt-2">
            {t('publicSite.privacy.section5.bodyPrefix')}{' '}
            <a href="/contact" className="text-accent-foreground hover:underline">
              {t('publicSite.privacy.section5.contactLink')}
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  )
}
