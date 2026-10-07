import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { NewContractDialog } from './NewContractDialog'

const mockRpc = vi.fn()
const mockNavigate = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    from: vi.fn(),
  },
}))

vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => ({
    currentClubId: 'club-1',
    currentMembership: { permissionKeys: ['rental.view', 'rental.contract.create', 'payment.create'] },
  }),
}))

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => mockNavigate,
}))

const SPACE = {
  id: 'space-1', branch_id: 'b1', branch_name: 'Main', name: 'Gym hall', space_type: 'gym', custom_type_label: null,
  description: null, area_sqm: null, capacity: null, default_rent_cycle: 'monthly', default_rent_amount: 15000,
  allow_overlapping_contracts: false, status: 'active', created_at: '2026-10-01', active_contracts_count: 0,
  current_contract: null, next_contract_start: null,
}

function renderDialog(onCreated = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Spaces already cached, exactly as when the dialog is opened from the Spaces tab.
  queryClient.setQueryData(['rental-spaces', 'club-1', false], [SPACE])
  render(
    <QueryClientProvider client={queryClient}>
      <DirectionProvider>
        <MemoryRouter>
          <NewContractDialog
            initialSpaceId="space-1"
            initialCustomer={{ id: 'cust-1', fullName: 'Tenant', mobileDisplay: null }}
            onClose={vi.fn()}
            onCreated={onCreated}
          />
        </MemoryRouter>
      </DirectionProvider>
    </QueryClientProvider>,
  )
  return { onCreated }
}

describe('NewContractDialog', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    mockNavigate.mockReset()
    mockRpc.mockImplementation((name: string) => {
      if (name === 'list_rental_spaces') return Promise.resolve({ data: [SPACE], error: null })
      if (name === 'create_rental_contract') {
        return Promise.resolve({ data: [{ contract_id: 'c1', contract_number: 'RC-00001', invoice_id: 'inv-1' }], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })
    await i18n.changeLanguage('ar')
  })

  it('previews the lease end date from the space defaults and creates the contract, then opens the first invoice', async () => {
    const { onCreated } = renderDialog()
    const today = new Date().toISOString().slice(0, 10)

    fireEvent.change(screen.getByDisplayValue(today), { target: { value: '2026-07-29' } })
    fireEvent.change(screen.getAllByDisplayValue('0')[0]!, { target: { value: '30000' } }) // security deposit (first '0' field)

    // 12 monthly periods from 2026-07-29 -> inclusive end 2027-07-28
    expect(await screen.findByDisplayValue('2027-07-28')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'إنشاء العقد' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    const call = mockRpc.mock.calls.find(([name]) => name === 'create_rental_contract')
    expect(call?.[1]).toMatchObject({
      p_club_id: 'club-1',
      p_space_id: 'space-1',
      p_customer_id: 'cust-1',
      p_start_date: '2026-07-29',
      p_rent_cycle: 'monthly',
      p_cycles_count: 12,
      p_cycle_amount: 15000,
      p_security_deposit: 30000,
      p_issue_first_invoice: true,
    })
    expect(mockNavigate).toHaveBeenCalledWith('/app/finance/payments?invoice=inv-1')
  })

  it('opens the contract (not one invoice) when the deposit is invoiced separately', async () => {
    mockRpc.mockImplementation((name: string) => {
      if (name === 'list_rental_spaces') return Promise.resolve({ data: [SPACE], error: null })
      if (name === 'create_rental_contract') {
        return Promise.resolve({ data: [{ contract_id: 'c1', contract_number: 'RC-00001', invoice_id: 'inv-1', deposit_invoice_id: 'inv-2' }], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    })
    const { onCreated } = renderDialog()
    fireEvent.change(screen.getAllByDisplayValue('0')[0]!, { target: { value: '5000' } })
    fireEvent.change(screen.getAllByDisplayValue('0')[0]!, { target: { value: '10' } }) // annual increase %
    fireEvent.click(screen.getByRole('button', { name: 'إنشاء العقد' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('c1'))
    const call = mockRpc.mock.calls.find(([name]) => name === 'create_rental_contract')
    expect(call?.[1]).toMatchObject({ p_security_deposit: 5000, p_annual_increase_pct: 10, p_start_time: undefined })
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
