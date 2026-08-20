import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import i18n from './i18n/config'
import { translateSupabaseError } from './errors'

// Dedicated automated tests for the error-translation rules covering
// this session's new critical invariants (cash-shift gate, government
// receipt gate) -- required by the directive's automated-test mandate,
// and a direct regression test for a real bug found via live QA: these
// two RPC errors previously had no matching rule and fell through to a
// generic, misleading fallback message ("slot may be booked or
// unauthorized") instead of their real, actionable cause.
describe('translateSupabaseError — cash shift + government receipt rules', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('ar')
  })
  afterEach(async () => {
    await i18n.changeLanguage('ar')
  })

  it('translates the cash-shift-required RPC error distinctly from the generic fallback (ar)', () => {
    const error = { message: 'cash collection requires an active cash shift -- open one before collecting cash' }
    const result = translateSupabaseError(error, 'FALLBACK')
    expect(result).not.toBe('FALLBACK')
    expect(result).toContain('وردية نقدية مفتوحة')
  })

  it('translates the cash-shift-required RPC error in English when the UI language is English', async () => {
    await i18n.changeLanguage('en')
    const error = { message: 'cash collection requires an active cash shift -- open one before collecting cash' }
    const result = translateSupabaseError(error, 'FALLBACK')
    expect(result).toBe('Cash collection requires an active cash shift — open one before collecting cash.')
  })

  it('translates the branch-scoped-booking cash error', () => {
    const error = { message: 'cash collection requires a branch-scoped booking -- this invoice has none' }
    const result = translateSupabaseError(error, 'FALLBACK')
    expect(result).not.toBe('FALLBACK')
    expect(result).toContain('حجزًا مرتبطًا بفرع')
  })

  it('translates the official-receipt-required RPC error distinctly from the generic fallback', () => {
    const error = { message: 'official collection receipt required: this club/field requires an official government collection receipt for cash payments' }
    const result = translateSupabaseError(error, 'FALLBACK')
    expect(result).not.toBe('FALLBACK')
    expect(result).toContain('إيصال تحصيل رسمي')
  })

  it('translates the receipt-already-linked RPC error', () => {
    const error = { message: 'this official collection receipt is already linked to a payment' }
    const result = translateSupabaseError(error, 'FALLBACK')
    expect(result).toContain('مرتبط بالفعل بدفعة أخرى')
  })

  it('translates the receipt-amount-mismatch RPC error', () => {
    const error = { message: 'official collection receipt amount (100.00) does not match the payment amount (150.00)' }
    const result = translateSupabaseError(error, 'FALLBACK')
    expect(result).toContain('لا تطابق قيمة الدفعة')
  })

  it('translates the future-dated-receipt RPC error', () => {
    const error = { message: 'receipt date cannot be in the future' }
    const result = translateSupabaseError(error, 'FALLBACK')
    expect(result).toContain('لا يمكن أن يكون في المستقبل')
  })

  it('translates the past-booking-time RPC error (Phase C)', () => {
    const error = { message: 'booking time must be in the future' }
    const result = translateSupabaseError(error, 'FALLBACK')
    expect(result).toContain('يجب أن يكون في المستقبل')
  })

  it('still falls back to the generic message for a genuinely unrecognized error', () => {
    const error = { message: 'some totally unrelated internal error xyz123' }
    const result = translateSupabaseError(error, 'FALLBACK')
    expect(result).toBe('FALLBACK')
  })

  it('does not confuse the cash-shift error with the receipt error (distinct messages)', () => {
    const shiftError = { message: 'cash collection requires an active cash shift -- open one before collecting cash' }
    const receiptError = { message: 'official collection receipt required: this club/field requires an official government collection receipt for cash payments' }
    expect(translateSupabaseError(shiftError, 'FALLBACK')).not.toBe(translateSupabaseError(receiptError, 'FALLBACK'))
  })
})
