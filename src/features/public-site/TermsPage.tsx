// Initial usable V1 legal content -- accurate to what Mala3by actually is
// and does today, deliberately not over-engineered (no clause-by-clause
// legal drafting, no jurisdiction-specific boilerplate). Replaces the
// placeholder found during the Final Release Gate (2026-08-15). Should be
// reviewed by qualified legal counsel before the public production launch
// (Phase 18) if the business wants a fully binding contract -- this is a
// good-faith initial version, not a substitute for that review.
export function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-2xl font-bold text-text-primary">الشروط والأحكام</h1>
      <p className="mt-2 text-sm text-text-secondary">آخر تحديث: 15 أغسطس 2026</p>

      <div className="mt-6 flex flex-col gap-6 text-text-secondary">
        <section>
          <h2 className="text-lg font-semibold text-text-primary">١. عن الخدمة</h2>
          <p className="mt-2">
            ملعبي (Mala3by) منصة إدارة تشغيلية للأندية الرياضية والأكاديميات — الحجوزات، الفواتير
            والمدفوعات، اللاعبون والاشتراكات، الحضور عبر QR، والتقارير. باستخدامك الخدمة فإنك توافق
            على هذه الشروط.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">٢. الحساب والاشتراك</h2>
          <p className="mt-2">
            يبدأ كل نادٍ جديد بتجربة مجانية لمدة 7 أيام دون الحاجة لبطاقة بنكية، تُمنح مرة واحدة لكل
            مستخدم. بعد انتهاء التجربة، يتطلب الاستمرار في استخدام المنصة اشتراكًا مدفوعًا يُفعَّل
            بالتواصل مع فريق ملعبي. أنت مسؤول عن دقة بيانات ناديك وعن الحفاظ على سرية بيانات الدخول
            الخاصة بحسابك.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">٣. البيانات التي تُدخلها</h2>
          <p className="mt-2">
            بيانات العملاء واللاعبين والحجوزات والفواتير التي تُدخلها في نظامك تبقى ملكًا لك ولناديك.
            نحن نخزّنها لتشغيل الخدمة فقط ولا نستخدمها لأي غرض آخر خارج ما هو موضّح في سياسة
            الخصوصية.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">٤. الدفع والفواتير</h2>
          <p className="mt-2">
            رسوم الاشتراك في المنصة تُحصَّل حسب الخطة التي يختارها النادي، ولا تشمل مدفوعات النادي
            الخاصة بعملائه (تلك تُدار داخل نظامك الخاص ولا تمر عبر ملعبي). لا يتم خصم أي مبلغ تلقائيًا
            دون تأكيد صريح منك.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">٥. إنهاء الخدمة</h2>
          <p className="mt-2">
            يمكنك التوقف عن استخدام المنصة في أي وقت بالتواصل معنا. نحتفظ بحق تعليق الوصول عند إساءة
            استخدام واضحة للخدمة أو عدم سداد الاشتراك بعد فترة السماح المتفق عليها.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">٦. التواصل</h2>
          <p className="mt-2">
            لأي استفسار حول هذه الشروط، يمكنك التواصل معنا عبر صفحة{' '}
            <a href="/contact" className="text-accent-foreground hover:underline">
              تواصل معنا
            </a>
            .
          </p>
        </section>
      </div>
    </div>
  )
}
