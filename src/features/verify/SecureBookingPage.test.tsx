import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { initI18n } from '@/lib/i18n/config'
import i18n from 'i18next'
import { SecureBookingPage } from './SecureBookingPage'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/client', () => ({ supabase: { rpc } }))
vi.mock('@/app/providers/DirectionProvider', () => ({ useDirection: () => ({ locale: 'en', direction: 'ltr', setLocale: vi.fn() }) }))
vi.mock('@/components/ui/language-switcher', () => ({ LanguageSwitcher: () => null }))
vi.mock('@/features/public-booking/PaymentMethodsPanel', () => ({ PaymentMethodsPanel: ({ total }: { total: number }) => <div data-testid="payment-methods">Pay {total}</div> }))

const context = {
  result: 'valid', booking_id: 'booking-1', club_id: 'club-1', booking_ref: 'MB-1234ABCD',
  club_name: 'Test club', field_name: 'Court 1', booking_status: 'pending_payment',
  total: 350, paid: 100, outstanding: 250, currency: 'EGP', payment_status: 'partially_paid',
  can_pay: true, can_check_in: false, hold_expires_at: new Date(Date.now() + 3600000).toISOString(),
}
beforeAll(async () => { await initI18n(); await i18n.changeLanguage('en') })
beforeEach(() => { cleanup(); rpc.mockReset() })
function page() {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
    <MemoryRouter initialEntries={['/qr/' + 'a'.repeat(64)]}><Routes><Route path="/qr/:token" element={<SecureBookingPage />} /></Routes></MemoryRouter>
  </QueryClientProvider>)
}
describe('server-backed booking recovery', () => {
  it('opens from only a URL and uses the outstanding balance, not the original total', async () => {
    rpc.mockResolvedValue({ data: context, error: null })
    page()
    expect((await screen.findByTestId('payment-methods')).textContent).toBe('Pay 250')
    expect(rpc).toHaveBeenCalledWith('get_public_booking_context', { p_token: 'a'.repeat(64) })
    expect(screen.queryByRole('button', { name: 'View QR Code for Check-in' })).toBeNull()
  })
  it('reads updated server payment state when reopened, without restoring a stale snapshot', async () => {
    rpc.mockResolvedValueOnce({ data: context, error: null })
    const first = page()
    await screen.findByTestId('payment-methods')
    first.unmount()
    rpc.mockResolvedValue({ data: { ...context, paid: 350, outstanding: 0, payment_status: 'paid', booking_status: 'confirmed' }, error: null })
    page()
    await screen.findByText('Your booking is fully paid. Nothing is outstanding.')
    expect(screen.queryByTestId('payment-methods')).toBeNull()
  })
  it('does not offer payment after the hold expires', async () => {
    rpc.mockResolvedValue({ data: { ...context, hold_expires_at: '2020-01-01T00:00:00Z' }, error: null })
    page()
    await screen.findByText('Court 1', { selector: 'p.font-semibold' })
    expect(screen.queryByTestId('payment-methods')).toBeNull()
  })
  it('distinguishes network failure from an invalid link and offers retry', async () => {
    rpc.mockResolvedValue({ data: null, error: new Error('offline') })
    page()
    expect((await screen.findByRole('alert')).textContent).toContain('couldn’t refresh')
    expect(screen.queryByText('Invalid code')).toBeNull()
  })
  it('never renders payment or details for an invalid credential', async () => {
    rpc.mockResolvedValue({ data: { result: 'invalid' }, error: null })
    page()
    await screen.findByText('Invalid code')
    expect(screen.queryByTestId('payment-methods')).toBeNull()
    expect(screen.queryByText('Court 1')).toBeNull()
  })
})
