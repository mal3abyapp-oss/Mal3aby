import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { PlatformRolesPage } from './PlatformRolesPage'

// RBAC-1 (owner brief, 2026-09-21): the 12 real platform.sales.* keys
// (platform_permissions catalog, group_key='sales' since
// 20260904090100_sales_intelligence_rls_and_permissions.sql) were fully
// enforced server-side but had no tab in this screen -- 'sales' was
// missing from the hardcoded PLATFORM_PERMISSION_GROUPS array every
// render here is driven off, so a Platform Owner had no way to grant
// any Sales Intelligence permission to a custom role. This test proves
// the fix: the Sales Intelligence group tab exists, is selectable, and
// its checkboxes render one of the real catalog keys.

const mockRpc = vi.fn()
const mockFrom = vi.fn()

const CATALOG = [
  { key: 'platform.staff.view', group_key: 'staff' },
  { key: 'platform.sales.view', group_key: 'sales' },
  { key: 'platform.sales.approve_outreach', group_key: 'sales' },
]

vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: (...args: unknown[]) => mockFrom(...args),
  },
}))

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <PlatformRolesPage />
    </QueryClientProvider>,
  )
}

describe('PlatformRolesPage — RBAC-1: Sales Intelligence permission group', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    mockFrom.mockReset()
    await i18n.changeLanguage('en')

    mockRpc.mockImplementation((fnName: string) => {
      if (fnName === 'list_platform_roles') return Promise.resolve({ data: [], error: null })
      if (fnName === 'caller_platform_permission_keys') {
        return Promise.resolve({ data: ['platform.sales.view', 'platform.sales.approve_outreach'], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'platform_permissions') {
        return { select: () => Promise.resolve({ data: CATALOG, error: null }) }
      }
      return { select: () => Promise.resolve({ data: [], error: null }) }
    })
  })

  it('shows a Sales Intelligence tab and its permissions when creating a custom role', async () => {
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: i18n.t('platformRoles.createRole') }))

    // Both the mobile tab-strip and the desktop sidebar render every
    // group button in the DOM simultaneously (shown/hidden via
    // Tailwind's md:hidden/hidden md:flex, not conditional rendering) --
    // jsdom applies no real viewport, so both are always present.
    const salesTabs = await screen.findAllByRole('button', { name: i18n.t('platformRoles.groups.sales') })
    expect(salesTabs.length).toBeGreaterThan(0)

    fireEvent.click(salesTabs[0]!)

    expect(await screen.findByText(i18n.t('platformPermissions.platform.sales.view.label'))).toBeInTheDocument()
    expect(screen.getByText(i18n.t('platformPermissions.platform.sales.approve_outreach.label'))).toBeInTheDocument()
  })
})
