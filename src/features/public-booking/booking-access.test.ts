import { describe, expect, it } from 'vitest'
import { bookingPathFromLink } from './booking-access'

const token = 'a'.repeat(64)
describe('booking link navigation', () => {
  it('accepts a secure booking link and strips untrusted query parameters', () => {
    expect(bookingPathFromLink(`https://mal3aby.app/qr/${token}?redirect=https://evil.test`, 'https://mal3aby.app')).toBe(`/qr/${token}`)
  })
  it.each([`https://evil.test/qr/${token}`, `javascript:alert(1)`, `/qr/MB-12345678`, `/qr/${token}/extra`, `https://mal3aby.app.evil.test/qr/${token}`])('rejects unsafe or non-credential input %s', value => {
    expect(bookingPathFromLink(value, 'https://mal3aby.app')).toBeNull()
  })
})
