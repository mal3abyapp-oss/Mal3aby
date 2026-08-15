import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { CalendarDays, GraduationCap, Receipt, ScanLine, BarChart3, UserCog } from 'lucide-react'

// Full marketing content (public_plans-sourced pricing, FAQ, etc.) lands in
// Phase 3d — see docs/USER_FLOWS.md Flow 8, docs/SCREEN_MAP.md Home.
// This is the Phase-1 shell verifying PublicLayout renders correctly.
const features = [
  { icon: CalendarDays, label: 'الحجوزات' },
  { icon: GraduationCap, label: 'الأكاديمية' },
  { icon: Receipt, label: 'الفواتير والمدفوعات' },
  { icon: ScanLine, label: 'QR' },
  { icon: BarChart3, label: 'التقارير' },
  { icon: UserCog, label: 'إدارة الموظفين' },
]

export function HomePage() {
  return (
    <>
      <section className="bg-dark-base text-white">
        <div className="mx-auto max-w-4xl px-4 py-24 text-center">
          <h1 className="text-3xl font-bold md:text-5xl">
            إدارة ناديك وأكاديميتك وملاعبك من مكان واحد
          </h1>
          <p className="mt-4 text-lg text-white/70">
            الحجوزات، الاشتراكات، اللاعبين، الفواتير، الحضور، QR والتقارير في نظام واحد سهل الاستخدام.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Button size="lg" className="bg-accent text-accent-foreground hover:bg-accent/90" asChild>
              <Link to="/signup">ابدأ تجربتك المجانية</Link>
            </Button>
            <Button size="lg" variant="outline" className="border-white/30 text-white hover:bg-white/10" asChild>
              <Link to="/login">تسجيل الدخول</Link>
            </Button>
          </div>
          <p className="mt-3 text-sm text-white/50">7 أيام مجانًا · بدون بطاقة بنكية</p>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-5xl px-4 py-16">
        <h2 className="text-center text-2xl font-bold text-text-primary">المزايا الأساسية</h2>
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-6">
          {features.map((f) => (
            <div key={f.label} className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-4">
              <f.icon className="size-6 text-accent-foreground" />
              <span className="text-sm text-text-secondary">{f.label}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
