import { Outlet } from 'react-router-dom'
import { ShopNav } from './components/ShopNav'
import { RequireShopModule } from '@/app/routing/RequireAuth'

// COMMERCIAL MODULE (2026-08-26) -- the one Shop shell every
// product/inventory/sales/return screen lives under, mirroring
// FinanceLayout's exact pattern (shared sub-nav, each tab keeps its
// own PageHeader). RequireShopModule wraps every child so "Shop not
// entitled/activated" shows once, consistently, instead of each tab
// separately handling the empty-module case.
export function ShopLayout() {
  return (
    <div>
      <ShopNav />
      <RequireShopModule>
        <Outlet />
      </RequireShopModule>
    </div>
  )
}
