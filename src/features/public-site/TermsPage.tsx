import { useTranslation } from 'react-i18next'

// Initial usable V1 legal content -- accurate to what Mala3by actually is
// and does today, deliberately not over-engineered (no clause-by-clause
// legal drafting, no jurisdiction-specific boilerplate). Replaces the
// placeholder found during the Final Release Gate (2026-08-15). Should be
// reviewed by qualified legal counsel before the public production launch
// (Phase 18) if the business wants a fully binding contract -- this is a
// good-faith initial version, not a substitute for that review.
export function TermsPage() {
  const { t } = useTranslation()
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-2xl font-bold text-text-primary">{t('publicSite.terms.title')}</h1>
      <p className="mt-2 text-sm text-text-secondary">{t('publicSite.terms.lastUpdated')}</p>

      <div className="mt-6 flex flex-col gap-6 text-text-secondary">
        <section>
          <h2 className="text-lg font-semibold text-text-primary">{t('publicSite.terms.section1.title')}</h2>
          <p className="mt-2">
            {t('publicSite.terms.section1.body')}
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">{t('publicSite.terms.section2.title')}</h2>
          <p className="mt-2">
            {t('publicSite.terms.section2.body')}
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">{t('publicSite.terms.section3.title')}</h2>
          <p className="mt-2">
            {t('publicSite.terms.section3.body')}
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">{t('publicSite.terms.section4.title')}</h2>
          <p className="mt-2">
            {t('publicSite.terms.section4.body')}
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">{t('publicSite.terms.section5.title')}</h2>
          <p className="mt-2">
            {t('publicSite.terms.section5.body')}
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">{t('publicSite.terms.section6.title')}</h2>
          <p className="mt-2">
            {t('publicSite.terms.section6.bodyPrefix')}{' '}
            <a href="/contact" className="text-accent-foreground hover:underline">
              {t('publicSite.terms.section6.contactLink')}
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  )
}
