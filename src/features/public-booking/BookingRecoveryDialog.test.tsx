import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { initI18n } from '@/lib/i18n/config'
import i18n from 'i18next'
import { BookingRecoveryDialog } from './BookingRecoveryDialog'

const rpc = vi.hoisted(() => vi.fn())
const navigate = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase/client', () => ({ supabase: { rpc } }))
vi.mock('@/app/providers/DirectionProvider', () => ({ useDirection: () => ({ locale: 'en', direction: 'ltr' }) }))
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

beforeEach(async () => {
  cleanup()
  rpc.mockReset()
  navigate.mockReset()
  await initI18n()
  await i18n.changeLanguage('en')
})

function dialog(onOpenChange = vi.fn()) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <MemoryRouter>
        <BookingRecoveryDialog open onOpenChange={onOpenChange} slug="demo-club" country="EG" phone="+201000000000" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// GAP CLOSURE (2026-09-14, owner: "اجعل عند وضع رقم الحجز يرسل
// المستخدم الي صفحه الحجز مثل الرابط") -- entering a ref + matching
// phone previously only queued a WhatsApp/email resend
// (request_public_booking_link); it now resolves directly to a real
// token and navigates straight to /qr/:token, same destination as the
// "I have a link" tab.
describe('BookingRecoveryDialog — ref+phone resolves directly to the booking, like a link', () => {
  it('navigates to /qr/:token on a genuine ref+phone match, closing the dialog', async () => {
    rpc.mockResolvedValue({ data: { result: 'valid', token: 'a'.repeat(64) }, error: null })
    const onOpenChange = vi.fn()
    dialog(onOpenChange)
    fireEvent.change(screen.getByPlaceholderText('MB-1234ABCD'), { target: { value: 'MB-ABCDEF12' } })
    fireEvent.change(screen.getByPlaceholderText('01xxxxxxxxx'), { target: { value: '01012345678' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Open booking and payment' }))
    await vi.waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('resolve_public_booking_by_ref_and_phone', {
        p_club_slug: 'demo-club', p_booking_ref: 'MB-ABCDEF12', p_phone_e164: '+201012345678',
      })
    })
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(`/qr/${'a'.repeat(64)}?lang=en`))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
  it('shows a not-found message on a miss, without navigating or closing the dialog', async () => {
    rpc.mockResolvedValue({ data: { result: 'invalid' }, error: null })
    const onOpenChange = vi.fn()
    dialog(onOpenChange)
    fireEvent.change(screen.getByPlaceholderText('MB-1234ABCD'), { target: { value: 'MB-00000000' } })
    fireEvent.change(screen.getByPlaceholderText('01xxxxxxxxx'), { target: { value: '01099999999' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Open booking and payment' }))
    await screen.findByText(/couldn.t find a booking/i)
    expect(navigate).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
  it('a blank reference still uses the phone-only fan-out path, not the resolver', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    dialog()
    fireEvent.change(screen.getByPlaceholderText('01xxxxxxxxx'), { target: { value: '01012345678' } })
    fireEvent.click(await screen.findByRole('button', { name: 'Send my booking links' }))
    await vi.waitFor(() => {
      expect(rpc).toHaveBeenCalledWith('request_public_booking_links_by_phone', {
        p_club_slug: 'demo-club', p_phone_e164: '+201012345678',
      })
    })
    expect(rpc).not.toHaveBeenCalledWith('resolve_public_booking_by_ref_and_phone', expect.anything())
  })
})
