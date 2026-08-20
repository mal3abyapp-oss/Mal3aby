import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { Receipt } from 'lucide-react'

// Finance IA consolidation directive sections 25/60: "If no Expenses
// architecture exists in the system, do not invent an Accounting ERP
// from scratch -- verify first." Verified directly against the live
// schema: no `expenses` table, no expense_* RPC, no expense migration
// exists anywhere in this codebase (confirmed via a full audit pass
// before this module was built). This tab exists so the nav item the
// directive's target IA (section 84) lists is not simply missing --
// but it states the real state plainly instead of faking data or
// building unrequested backend.
export function FinanceExpensesPage() {
  const { t } = useTranslation()
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <Receipt className="size-8 text-text-secondary" />
        <p className="font-medium">{t('finance.expenses.notBuiltTitle')}</p>
        <p className="max-w-md text-sm text-text-secondary">{t('finance.expenses.notBuiltDescription')}</p>
      </CardContent>
    </Card>
  )
}
