import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  Receipt, ListOrdered, Package, Shapes, CreditCard, Users, UserCheck, Undo2,
  Boxes, History, AlertTriangle, XCircle, Wallet, TrendingUp, Truck, ClipboardCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { ReportsNav } from '@/features/reports/components/ReportsNav'
import {
  ReportShopSalesSummaryContent,
  ReportShopSalesDetailContent,
} from '@/features/shop/reports/ShopSalesSummaryReports'
import {
  ReportShopProductSalesContent,
  ReportShopCategorySalesContent,
  ReportShopPaymentMethodSalesContent,
  ReportShopCashierSalesContent,
  ReportShopCustomerPurchasesContent,
} from '@/features/shop/reports/ShopSalesReports'
import { ReportShopReturnsContent } from '@/features/shop/reports/ShopReturnsReport'
import {
  ReportShopInventoryOnHandContent,
  ReportShopStockMovementLedgerContent,
  ReportShopLowStockContent,
  ReportShopOutOfStockContent,
  ReportShopStockValuationContent,
  ReportShopSupplierActivityContent,
  ReportShopStockCountVarianceContent,
} from '@/features/shop/reports/ShopInventoryReports'
import { ReportShopGrossProfitContent } from '@/features/shop/reports/ShopProfitReport'

// Commerce Pro C7 (COMMERCE_PRO_UPGRADE_PLAN.md Section 5, Phase C7):
// the 16-report suite. Structured as ONE hub page with a URL-
// addressable ?tab= sub-report switcher -- the exact same pattern
// FinanceReportsPage.tsx already established for its own 8-report
// hub (directive precedent, not a new IA invention): 16 separate
// top-level routes would fragment ShopNav far beyond what a single
// scrollable tab strip can hold, while a flat "Reports" page with
// internal tab state (rather than 16 routes) keeps each report
// independently deep-linkable via ?tab= and keeps the existing
// /app/reports/shop route meaningful as the entry point (redirects
// semantically preserved: /app/reports/shop is this hub, unchanged
// URL, richer content).
type ReportKey =
  | 'sales-summary' | 'sales-detail' | 'product-sales' | 'category-sales' | 'payment-method-sales'
  | 'cashier-sales' | 'customer-purchases' | 'returns' | 'inventory-on-hand' | 'stock-movement-ledger'
  | 'low-stock' | 'out-of-stock' | 'stock-valuation' | 'gross-profit' | 'supplier-activity' | 'stock-count-variance'

const REPORT_TABS: { key: ReportKey; labelKey: string; icon: LucideIcon }[] = [
  { key: 'sales-summary', labelKey: 'shop.reports.tabs.salesSummary', icon: Receipt },
  { key: 'sales-detail', labelKey: 'shop.reports.tabs.salesDetail', icon: ListOrdered },
  { key: 'product-sales', labelKey: 'shop.reports.tabs.productSales', icon: Package },
  { key: 'category-sales', labelKey: 'shop.reports.tabs.categorySales', icon: Shapes },
  { key: 'payment-method-sales', labelKey: 'shop.reports.tabs.paymentMethodSales', icon: CreditCard },
  { key: 'cashier-sales', labelKey: 'shop.reports.tabs.cashierSales', icon: UserCheck },
  { key: 'customer-purchases', labelKey: 'shop.reports.tabs.customerPurchases', icon: Users },
  { key: 'returns', labelKey: 'shop.reports.tabs.returns', icon: Undo2 },
  { key: 'inventory-on-hand', labelKey: 'shop.reports.tabs.inventoryOnHand', icon: Boxes },
  { key: 'stock-movement-ledger', labelKey: 'shop.reports.tabs.stockMovementLedger', icon: History },
  { key: 'low-stock', labelKey: 'shop.reports.tabs.lowStock', icon: AlertTriangle },
  { key: 'out-of-stock', labelKey: 'shop.reports.tabs.outOfStock', icon: XCircle },
  { key: 'stock-valuation', labelKey: 'shop.reports.tabs.stockValuation', icon: Wallet },
  { key: 'gross-profit', labelKey: 'shop.reports.tabs.grossProfit', icon: TrendingUp },
  { key: 'supplier-activity', labelKey: 'shop.reports.tabs.supplierActivity', icon: Truck },
  { key: 'stock-count-variance', labelKey: 'shop.reports.tabs.stockCountVariance', icon: ClipboardCheck },
]

const REPORT_KEYS = new Set<ReportKey>(REPORT_TABS.map((t) => t.key))
function isReportKey(v: string | null): v is ReportKey {
  return v !== null && REPORT_KEYS.has(v as ReportKey)
}

export function ShopReportsPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const [reportKey, setReportKey] = useState<ReportKey>(isReportKey(tabParam) ? tabParam : 'sales-summary')

  const selectReport = (key: ReportKey) => {
    setReportKey(key)
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      next.set('tab', key)
      return next
    }, { replace: true })
  }

  return (
    <div>
      <div className="print:hidden">
        <ReportsNav />
        <PageHeader title={t('shop.reports.hubTitle')} description={t('shop.reports.hubDescription')} />
      </div>

      <div className="mb-4 flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1 print:hidden">
        {REPORT_TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => selectReport(tab.key)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all',
              reportKey === tab.key ? 'bg-background text-foreground shadow' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <tab.icon className="size-4" />
            {t(tab.labelKey)}
          </button>
        ))}
      </div>

      {reportKey === 'sales-summary' && <ReportShopSalesSummaryContent />}
      {reportKey === 'sales-detail' && <ReportShopSalesDetailContent />}
      {reportKey === 'product-sales' && <ReportShopProductSalesContent />}
      {reportKey === 'category-sales' && <ReportShopCategorySalesContent />}
      {reportKey === 'payment-method-sales' && <ReportShopPaymentMethodSalesContent />}
      {reportKey === 'cashier-sales' && <ReportShopCashierSalesContent />}
      {reportKey === 'customer-purchases' && <ReportShopCustomerPurchasesContent />}
      {reportKey === 'returns' && <ReportShopReturnsContent />}
      {reportKey === 'inventory-on-hand' && <ReportShopInventoryOnHandContent />}
      {reportKey === 'stock-movement-ledger' && <ReportShopStockMovementLedgerContent />}
      {reportKey === 'low-stock' && <ReportShopLowStockContent />}
      {reportKey === 'out-of-stock' && <ReportShopOutOfStockContent />}
      {reportKey === 'stock-valuation' && <ReportShopStockValuationContent />}
      {reportKey === 'gross-profit' && <ReportShopGrossProfitContent />}
      {reportKey === 'supplier-activity' && <ReportShopSupplierActivityContent />}
      {reportKey === 'stock-count-variance' && <ReportShopStockCountVarianceContent />}
    </div>
  )
}
