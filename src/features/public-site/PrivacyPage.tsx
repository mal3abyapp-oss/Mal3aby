// Initial usable V1 legal content -- accurate to what Mala3by actually
// stores and how (Supabase-hosted, RLS-isolated multi-tenant data), not
// over-engineered. Replaces the placeholder found during the Final
// Release Gate (2026-08-15). Should be reviewed by qualified legal
// counsel before the public production launch (Phase 18) if the business
// wants a fully binding policy -- this is a good-faith initial version.
export function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-2xl font-bold text-text-primary">سياسة الخصوصية</h1>
      <p className="mt-2 text-sm text-text-secondary">آخر تحديث: 15 أغسطس 2026</p>

      <div className="mt-6 flex flex-col gap-6 text-text-secondary">
        <section>
          <h2 className="text-lg font-semibold text-text-primary">١. البيانات التي نجمعها</h2>
          <p className="mt-2">
            عند إنشاء حساب: الاسم، البريد الإلكتروني، ورقم الهاتف. عند استخدام النظام: بيانات ناديك
            التشغيلية التي تُدخلها بنفسك (العملاء، اللاعبون، الحجوزات، الفواتير، الحضور) — لا نجمع أي
            بيانات إضافية عنك أو عن عملائك خارج ما تُدخله مباشرة في النظام.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">٢. كيف نستخدم بياناتك</h2>
          <p className="mt-2">
            نستخدم بياناتك فقط لتشغيل الخدمة: تسجيل الدخول، عرض بيانات ناديك، إصدار الفواتير،
            وإرسال رسائل تأكيد البريد الإلكتروني وإعادة تعيين كلمة المرور. لا نبيع بياناتك ولا
            نشاركها مع أي طرف ثالث لأغراض تسويقية.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">٣. عزل البيانات بين الأندية</h2>
          <p className="mt-2">
            كل نادٍ يرى بياناته الخاصة فقط. البنية التقنية للمنصة (سياسات أمان على مستوى قاعدة
            البيانات) تمنع أي نادٍ من الوصول إلى بيانات نادٍ آخر، بشكل مستقل عن واجهة الاستخدام.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">٤. أين تُخزَّن بياناتك</h2>
          <p className="mt-2">
            تُخزَّن البيانات لدى مزود خدمات سحابية (Supabase) باستخدام اتصال مشفّر. نحتفظ ببياناتك
            طالما كان حسابك نشطًا؛ عند إغلاق الحساب يمكنك طلب حذف بياناتك بالتواصل معنا.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold text-text-primary">٥. حقوقك</h2>
          <p className="mt-2">
            يمكنك في أي وقت طلب الاطلاع على بياناتك، تصحيحها، أو حذفها بالتواصل معنا عبر صفحة{' '}
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
