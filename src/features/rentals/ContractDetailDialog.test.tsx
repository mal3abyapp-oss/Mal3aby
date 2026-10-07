import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '@/lib/i18n/config'
import { DirectionProvider } from '@/app/providers/DirectionProvider'
import { ContractDetailDialog } from './ContractDetailDialog'

const mockRpc = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args), from: vi.fn() },
}))

vi.mock('@/app/providers/AuthProvider', () => ({
  useAuth: () => ({
    currentClubId: 'club-1',
    currentMembership: { permissionKeys: ['rental.view', 'rental.contract.create', 'rental.contract.manage', 'payment.create'] },
  }),
}))

const inst = (over: Record<string, unknown>) => ({
  id: 'i', kind: 'rent', sequence: 1, period_start: '2026-10-01', period_end: '2026-10-31', due_date: '2026-10-01',
  amount: 10000, invoice_id: null, invoice_number: null, invoice_status: null, status: 'scheduled', paid: 0, outstanding: 0,
  payment_state: 'scheduled', ...over,
})

const DETAIL = {
  contract: {
    id: 'c1', contract_number: 'RC-00002', rent_cycle: 'monthly', custom_cycle_value: null, custom_cycle_unit: null,
    cycles_count: 12, cycle_amount: 10000, total_rent: 120000, security_deposit: 5000, start_date: '2026-10-01',
    end_date: '2027-09-30', start_time: null, end_time: null, annual_increase_pct: 10, renewed_from_contract_id: 'c0',
    deposit_refunded: 0, deposit_kept: 0, deposit_settled_at: null, deposit_settlement_note: null, status: 'active',
    notes: null, termination_date: null, termination_reason: null, cancel_reason: null, created_at: '2026-10-01T10:00:00Z',
  },
  display_status: 'active',
  today: '2026-10-07',
  club: { name: 'Club', name_ar: 'النادي', logo_url: null },
  space: { id: 's1', name: 'Gym hall', space_type: 'gym', custom_type_label: null, branch_name: 'Main', branch_address: null, area_sqm: 200, capacity: null },
  customer: { id: 'cu1', full_name: 'Tenant One', mobile_display: null, national_id: '123', address: null },
  renewed_from: { id: 'c0', contract_number: 'RC-00001' },
  renewed_to: null,
  installments: [
    inst({ id: 'd', kind: 'deposit', sequence: 0, amount: 5000, invoice_id: 'inv-d', invoice_status: 'issued', status: 'invoiced', paid: 5000, payment_state: 'paid' }),
    inst({ id: 'r1', invoice_id: 'inv-1', invoice_status: 'issued', status: 'invoiced', paid: 10000, payment_state: 'paid' }),
    inst({ id: 'lf', kind: 'late_fee', sequence: 10001, amount: 500, invoice_id: 'inv-lf', invoice_status: 'issued', status: 'invoiced', outstanding: 500, payment_state: 'overdue' }),
  ],
  totals: {
    scheduled_total: 120500, invoiced: 10500, paid: 10000, outstanding: 500, not_invoiced: 110000, overdue: 500,
    late_fees: 500, deposit_collected: 5000, deposit_held: 5000, deposit_refunded: 0, deposit_kept: 0,
  },
}

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <DirectionProvider>
        <MemoryRouter>
          <ContractDetailDialog contractId="c1" onClose={vi.fn()} onChanged={vi.fn()} />
        </MemoryRouter>
      </DirectionProvider>
    </QueryClientProvider>,
  )
}

describe('ContractDetailDialog (v2)', () => {
  beforeEach(async () => {
    mockRpc.mockReset()
    mockRpc.mockImplementation((name: string) => {
      if (name === 'get_rental_contract_detail') return Promise.resolve({ data: DETAIL, error: null })
      if (name === 'settle_rental_deposit') return Promise.resolve({ data: { refunded: 3000 }, error: null })
      return Promise.resolve({ data: null, error: null })
    })
    await i18n.changeLanguage('ar')
  })

  it('shows late fees, the renewal chain and the lease actions, and settles the deposit with a deduction', async () => {
    renderDialog()
    expect(await screen.findByText('مجدد من RC-00001')).toBeInTheDocument()
    expect(screen.getAllByText('غرامة تأخير').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /طباعة العقد/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /تجديد العقد/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /تعديل العقد/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /تسوية التأمين/ }))
    const refundInput = await screen.findByDisplayValue('5000')
    fireEvent.change(refundInput, { target: { value: '3000' } })
    const confirm = screen.getByRole('button', { name: 'تأكيد التسوية' })
    expect(confirm).toBeDisabled() // a deduction needs a reason
    fireEvent.change(screen.getByPlaceholderText('مثال: إصلاح تلفيات الأرضية'), { target: { value: 'تلفيات' } })
    fireEvent.click(confirm)
    await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('settle_rental_deposit', {
      p_contract_id: 'c1', p_refund_amount: 3000, p_note: 'تلفيات',
    }))
  })
})
