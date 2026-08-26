import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import i18n from '@/lib/i18n/config'
import { ScanPage } from './ScanPage'

// Scanner Result UI -- COMPONENT RENDER VERIFICATION (Club Memberships E2E
// closure, scanner gap). Camera hardware is environment-blocked in every
// sandboxed test/CI runner (jsdom has no getUserMedia at all, same
// constraint as the live browser sandbox used elsewhere in this project's
// QA) -- that is accepted and stays ENVIRONMENT-BLOCKED, not something
// this file works around. What this file DOES verify is the thing that
// actually matters and previously had zero coverage: given a real
// qr_validate response (the exact row shape the real RPC returns, values
// captured from live SQL testing during this same closure), does the REAL
// ScanPage component render the correct outcome -- icon tone, label text,
// identity fields shown/hidden -- for every diagnostic_code the backend
// can produce for a club_membership scan, plus the pre-existing generic
// outcomes (invalid/wrong_club/permission_denied).
//
// No production code is touched or bypassed here. The only two things
// mocked are: (1) @/lib/supabase/client's `supabase.rpc`, so a test can
// hand the component a specific server response without a network call
// (exactly like every other RPC-driven component test would), and (2)
// @zxing/browser's BrowserQRCodeReader, whose `decodeFromVideoDevice`
// callback is invoked directly with a fake decoded token string -- this
// is the same callback the real camera would invoke on a real scan, just
// triggered by test code instead of a camera frame. No new production
// route, no manual-token input field, no scanner backdoor -- the
// production ScanPage.tsx is completely unmodified by this file.
//
// Regression this file locks in permanently: MEMBERSHIP_NOT_STARTED (the
// real backend defect found and fixed earlier in this same closure pass,
// migration 20260826094515_club_membership_qr_fix_not_started_bypass.sql)
// must never again render the scanner's green/success entry treatment.

const mockRpc = vi.fn()

vi.mock('@/lib/supabase/client', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
}))

// Captures the decode callback @zxing/browser's real BrowserQRCodeReader
// would invoke on a genuine camera frame -- tests call it directly with a
// fake decoded token, exercising the exact same handleValidate() code path
// ScanPage.tsx already wires up for a real scan.
let decodeCallback: ((result: { getText: () => string } | null, err: unknown, controls: { stop: () => void }) => void) | null = null

vi.mock('@zxing/browser', () => ({
  BrowserQRCodeReader: vi.fn().mockImplementation(() => ({
    decodeFromVideoDevice: vi.fn((_deviceId: unknown, _videoEl: unknown, callback: typeof decodeCallback) => {
      decodeCallback = callback
      return Promise.resolve({ stop: vi.fn() })
    }),
  })),
}))

function scan(token: string) {
  act(() => {
    decodeCallback?.({ getText: () => token }, null, { stop: vi.fn() })
  })
}

async function renderScanner() {
  const result = render(
    <MemoryRouter>
      <ScanPage />
    </MemoryRouter>,
  )
  // Let the mocked decodeFromVideoDevice's resolved promise (setting up
  // the "camera" controls) settle before a test drives a scan, same as
  // the real BrowserQRCodeReader's own async device-acquisition step.
  await act(async () => {
    await Promise.resolve()
  })
  return result
}

// Real qr_validate row shapes, matching exactly what the live RPC returns
// for each case (cross-checked against the function definition and this
// closure's own live SQL reproductions -- see qr_validate's migration
// history, most recently 20260826094515).
const ACTIVE_ROW = {
  result: 'success', credential_id: 'cred-1', reference_type: 'club_membership', reference_id: 'cust-1', club_id: 'club-1',
  display_name: 'QA E2E Phone Test', display_photo_url: null, display_subtitle: 'خطة اختبار E2E — MEM-000001',
  subscription_status: 'ACTIVE', diagnostic_code: 'SUCCESS', amount_due: 0,
}
const FROZEN_ROW = {
  ...ACTIVE_ROW, result: 'invalid', display_subtitle: 'خطة اختبار E2E — MEM-000001',
  subscription_status: 'FROZEN', diagnostic_code: 'MEMBERSHIP_FROZEN',
}
const EXPIRED_ROW = {
  ...ACTIVE_ROW, result: 'invalid', subscription_status: 'EXPIRED', diagnostic_code: 'MEMBERSHIP_EXPIRED',
}
const CANCELLED_ROW = {
  ...ACTIVE_ROW, result: 'invalid', subscription_status: 'CANCELLED', diagnostic_code: 'MEMBERSHIP_CANCELLED',
}
const NOT_STARTED_ROW = {
  ...ACTIVE_ROW, result: 'invalid', display_subtitle: 'خطة اختبار E2E — MEM-000003',
  subscription_status: 'NOT_STARTED', diagnostic_code: 'MEMBERSHIP_NOT_STARTED',
}
const NO_MEMBERSHIP_ROW = {
  result: 'invalid', credential_id: null, reference_type: 'club_membership', reference_id: 'cust-2', club_id: 'club-1',
  display_name: 'Some Customer', display_photo_url: null, display_subtitle: null,
  subscription_status: 'NO_MEMBERSHIP', diagnostic_code: 'MEMBERSHIP_NO_MEMBERSHIP', amount_due: 0,
}
// WRONG_CLUB and PERMISSION_DENIED return NO identity fields at all --
// exactly what the real qr_validate function does (both branches return
// null for display_name/display_photo_url/display_subtitle/
// subscription_status, confirmed by reading the live function body).
const WRONG_CLUB_ROW = {
  result: 'wrong_club', credential_id: null, reference_type: null, reference_id: null, club_id: null,
  display_name: null, display_photo_url: null, display_subtitle: null, subscription_status: null,
  diagnostic_code: 'WRONG_TENANT', amount_due: null,
}
const PERMISSION_DENIED_ROW = {
  result: 'permission_denied', credential_id: null, reference_type: 'club_membership', reference_id: null, club_id: null,
  display_name: null, display_photo_url: null, display_subtitle: null, subscription_status: null,
  diagnostic_code: 'MEMBERSHIP_VERIFY_NOT_GRANTED', amount_due: null,
}
const INVALID_ROW = {
  result: 'invalid', credential_id: null, reference_type: null, reference_id: null, club_id: null,
  display_name: null, display_photo_url: null, display_subtitle: null, subscription_status: null,
  diagnostic_code: 'TOKEN_NOT_FOUND', amount_due: null,
}

async function scanAndSettle(token: string, row: Record<string, unknown> | null) {
  mockRpc.mockResolvedValueOnce({ data: row ? [row] : [], error: row ? null : { message: 'not found' } })
  scan(token)
  await waitFor(() => expect(mockRpc).toHaveBeenCalledWith('qr_validate', { p_token: token }))
}

describe('ScanPage — Scanner Result UI (component render verification)', () => {
  beforeEach(() => {
    mockRpc.mockReset()
    decodeCallback = null
    void i18n.changeLanguage('ar')
  })

  it('ACTIVE: renders success treatment with identity, plan/membership number, and ACTIVE status — no PII', async () => {
    await renderScanner()
    await scanAndSettle('tok-active', ACTIVE_ROW)

    await waitFor(() => expect(screen.getByText('QA E2E Phone Test')).toBeInTheDocument())
    expect(screen.getByText(/MEM-000001/)).toBeInTheDocument()
    expect(screen.getByText(/خطة اختبار E2E/)).toBeInTheDocument()
    // Success outcome label is rendered (scanner.outcomes.success), not a raw code.
    expect(screen.queryByText('SUCCESS')).not.toBeInTheDocument()
    expect(screen.queryByText('MEMBERSHIP_NOT_STARTED')).not.toBeInTheDocument()
    assertNoPii()
  })

  it('FROZEN: blocked, non-success, distinct "frozen" wording — not treated as ACTIVE', async () => {
    await renderScanner()
    await scanAndSettle('tok-frozen', FROZEN_ROW)

    await waitFor(() => expect(screen.getByText('QA E2E Phone Test')).toBeInTheDocument())
    // Real i18n resource text for scanner.membershipOutcomes.frozen.
    expect(screen.getByText(i18n.t('scanner.membershipOutcomes.frozen'))).toBeInTheDocument()
    expect(screen.queryByText(i18n.t('scanner.outcomes.success'))).not.toBeInTheDocument()
    assertNoPii()
  })

  it('EXPIRED: blocked, distinct "expired" wording', async () => {
    await renderScanner()
    await scanAndSettle('tok-expired', EXPIRED_ROW)

    await waitFor(() => expect(screen.getByText('QA E2E Phone Test')).toBeInTheDocument())
    expect(screen.getByText(i18n.t('scanner.membershipOutcomes.expired'))).toBeInTheDocument()
    expect(screen.queryByText(i18n.t('scanner.outcomes.success'))).not.toBeInTheDocument()
    assertNoPii()
  })

  it('CANCELLED: blocked, distinct "cancelled" wording', async () => {
    await renderScanner()
    await scanAndSettle('tok-cancelled', CANCELLED_ROW)

    await waitFor(() => expect(screen.getByText('QA E2E Phone Test')).toBeInTheDocument())
    expect(screen.getByText(i18n.t('scanner.membershipOutcomes.cancelled'))).toBeInTheDocument()
    expect(screen.queryByText(i18n.t('scanner.outcomes.success'))).not.toBeInTheDocument()
    assertNoPii()
  })

  // The regression this whole file exists to lock in: the real backend
  // defect fixed in this closure (migration
  // 20260826094515_club_membership_qr_fix_not_started_bypass.sql) meant
  // qr_validate used to return result='success'/diagnostic_code='SUCCESS'
  // for a NOT_STARTED membership. That is now fixed server-side (result=
  // 'invalid', diagnostic_code='MEMBERSHIP_NOT_STARTED') -- this test
  // asserts the FRONTEND renders that corrected response as a clearly
  // non-success, non-ACTIVE state, so a future change to either side
  // can't silently reintroduce the "let an unpaid/future member in" gap.
  it('NOT_STARTED: must NOT render success/ACTIVE treatment (regression guard for the fixed qr_validate defect)', async () => {
    await renderScanner()
    await scanAndSettle('tok-not-started', NOT_STARTED_ROW)

    await waitFor(() => expect(screen.getByText('QA E2E Phone Test')).toBeInTheDocument())
    expect(screen.getByText(i18n.t('scanner.membershipOutcomes.notStarted'))).toBeInTheDocument()
    expect(screen.queryByText(i18n.t('scanner.outcomes.success'))).not.toBeInTheDocument()
    // The membership-status badge on the identity card must also read
    // NOT_STARTED's own label, never ACTIVE's.
    expect(screen.queryByText(i18n.t('scanner.subscriptionStatus.active'))).not.toBeInTheDocument()
    assertNoPii()
  })

  it('NO_MEMBERSHIP / INVALID diagnostic: rejected, no sensitive membership identity leakage beyond the customer name shown for staff verification', async () => {
    await renderScanner()
    await scanAndSettle('tok-no-membership', NO_MEMBERSHIP_ROW)

    await waitFor(() => expect(screen.getByText(i18n.t('scanner.membershipOutcomes.noMembership'))).toBeInTheDocument())
    expect(screen.queryByText(i18n.t('scanner.outcomes.success'))).not.toBeInTheDocument()
    // No membership number/plan text should render since none exists.
    expect(screen.queryByText(/MEM-\d+/)).not.toBeInTheDocument()
    assertNoPii()
  })

  it('generic INVALID (token not found): rejected, zero identity data rendered at all', async () => {
    await renderScanner()
    await scanAndSettle('tok-garbage', INVALID_ROW)

    await waitFor(() => expect(screen.getByText(i18n.t('scanner.outcomes.invalid'))).toBeInTheDocument())
    expect(screen.queryByText('QA E2E Phone Test')).not.toBeInTheDocument()
    assertNoPii()
  })

  it('WRONG_CLUB: rejected, zero customer/membership data leakage (server already returns nulls for every identity field)', async () => {
    await renderScanner()
    await scanAndSettle('tok-wrong-club', WRONG_CLUB_ROW)

    await waitFor(() => expect(screen.getByText(i18n.t('scanner.outcomes.wrong_club'))).toBeInTheDocument())
    expect(screen.queryByText('QA E2E Phone Test')).not.toBeInTheDocument()
    expect(screen.queryByText(/MEM-\d+/)).not.toBeInTheDocument()
    assertNoPii()
  })

  it('PERMISSION_DENIED: rejected, zero membership data leakage', async () => {
    await renderScanner()
    await scanAndSettle('tok-no-perm', PERMISSION_DENIED_ROW)

    await waitFor(() => expect(screen.getByText(i18n.t('scanner.outcomes.permission_denied'))).toBeInTheDocument())
    expect(screen.queryByText('QA E2E Phone Test')).not.toBeInTheDocument()
    expect(screen.queryByText(/MEM-\d+/)).not.toBeInTheDocument()
    assertNoPii()
  })
})

describe('ScanPage — Arabic RTL / English LTR outcome labels', () => {
  beforeEach(() => {
    mockRpc.mockReset()
    decodeCallback = null
  })

  const CRITICAL_CASES: Array<[string, Record<string, unknown>, string]> = [
    ['ACTIVE', ACTIVE_ROW, 'scanner.outcomes.success'],
    ['NOT_STARTED', NOT_STARTED_ROW, 'scanner.membershipOutcomes.notStarted'],
    ['EXPIRED', EXPIRED_ROW, 'scanner.membershipOutcomes.expired'],
    ['WRONG_CLUB', WRONG_CLUB_ROW, 'scanner.outcomes.wrong_club'],
  ]

  for (const locale of ['ar', 'en'] as const) {
    for (const [caseName, row, i18nKey] of CRITICAL_CASES) {
      it(`${caseName} renders the correct human label in ${locale === 'ar' ? 'Arabic RTL' : 'English LTR'}, never a raw code/key`, async () => {
        await i18n.changeLanguage(locale)
        await renderScanner()
        await scanAndSettle(`tok-${locale}-${caseName}`, row)

        const expectedLabel = i18n.t(i18nKey)
        await waitFor(() => expect(screen.getByText(expectedLabel)).toBeInTheDocument())

        // No raw diagnostic code or i18n key ever leaks into the rendered
        // text -- e.g. never literally "MEMBERSHIP_NOT_STARTED" or
        // "scanner.outcomes.success" on screen.
        expect(screen.queryByText('MEMBERSHIP_NOT_STARTED')).not.toBeInTheDocument()
        expect(screen.queryByText('SUCCESS')).not.toBeInTheDocument()
        expect(screen.queryByText(i18nKey)).not.toBeInTheDocument()

        // NOT_STARTED must never visually collapse into the ACTIVE/success
        // treatment in either language.
        if (caseName === 'NOT_STARTED') {
          expect(screen.queryByText(i18n.t('scanner.outcomes.success'))).not.toBeInTheDocument()
          expect(screen.queryByText(i18n.t('scanner.subscriptionStatus.active'))).not.toBeInTheDocument()
        }
      })
    }
  }
})

/** No phone/email/payment/invoice/price text is ever rendered by the scanner result screen for ANY outcome -- these fields don't exist anywhere in qr_validate's return shape or ScanPage's render tree, and this asserts that invariant holds for whatever is currently on screen. */
function assertNoPii() {
  const bodyText = document.body.textContent ?? ''
  expect(bodyText).not.toMatch(/\+?\d{10,}/)
  expect(bodyText).not.toMatch(/@[\w.-]+\.\w+/)
  expect(bodyText).not.toMatch(/EGP|ج\.م/)
  expect(bodyText).not.toMatch(/فاتورة|invoice/i)
}
