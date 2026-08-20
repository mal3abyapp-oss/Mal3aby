import { Outlet } from 'react-router-dom'
import { FinanceNav } from './components/FinanceNav'

// Finance IA consolidation directive: the one Finance shell every
// money-related screen now lives under. Renders only the shared sub-nav
// -- each tab (including Overview) keeps its own PageHeader with a
// title/description scoped to that tab, exactly like the pre-existing
// Reports module (ReportsOverviewPage has its own header; ReportsNav
// carries none). Avoids a doubled "Finance" + "Payments & Collections"
// header stack while still giving every tab a real, specific title
// (directive section 43: "should feel like one coherent module", not
// achieved by hiding each screen's own identity).
export function FinanceLayout() {
  return (
    <div>
      <FinanceNav />
      <Outlet />
    </div>
  )
}
