import { describe, it, expect } from 'vitest'
import { BOOKING_SOURCE_LABELS, BOOKING_STATUS_LABELS, BOOKING_STATUS_TONE } from './booking'
import en from '@/lib/i18n/resources/en/common.json'
import ar from '@/lib/i18n/resources/ar/common.json'

// FINAL BOOKINGS UX & LIFECYCLE GAP CLOSURE, Section I (test matrix
// items 25-29): source label localization. Real bookings_source_check
// values are exactly 'staff' | 'club_public_link' | 'club_qr'
// (confirmed live against the schema) -- this guards against label
// drift (a new source value added to the DB constraint without a
// matching UI label, or a typo'd key that would silently fall back to
// the raw enum string in the UI).
const REAL_SOURCE_VALUES = ['staff', 'club_public_link', 'club_qr'] as const
const REAL_STATUS_VALUES = ['pending_payment', 'confirmed', 'checked_in', 'completed', 'cancelled', 'no_show'] as const
const REAL_COMPLETION_SOURCE_VALUES = ['manual', 'automatic'] as const

describe('BOOKING_SOURCE_LABELS (Arabic fallback constants)', () => {
  it('item 27 (QR label present) + 25/26: covers every real bookings_source_check value', () => {
    for (const value of REAL_SOURCE_VALUES) {
      expect(BOOKING_SOURCE_LABELS[value]).toBeTruthy()
      expect(typeof BOOKING_SOURCE_LABELS[value]).toBe('string')
    }
  })

  it('item 25: staff source has a distinct, non-raw-enum label', () => {
    expect(BOOKING_SOURCE_LABELS.staff).not.toBe('staff')
  })

  it('item 26: public-link source has a distinct, non-raw-enum label', () => {
    expect(BOOKING_SOURCE_LABELS.club_public_link).not.toBe('club_public_link')
  })

  it('item 27: QR source has a distinct, non-raw-enum label', () => {
    expect(BOOKING_SOURCE_LABELS.club_qr).not.toBe('club_qr')
  })
})

describe('i18n resources: bookings.sourceLabels (item 28: Arabic, item 29: English)', () => {
  it('item 29 -- English: every real source value has an i18n key, none equal to the raw enum', () => {
    const labels = (en as { bookings: { sourceLabels: Record<string, string> } }).bookings.sourceLabels
    for (const value of REAL_SOURCE_VALUES) {
      expect(labels[value]).toBeTruthy()
      expect(labels[value]).not.toBe(value)
    }
  })

  it('item 28 -- Arabic: every real source value has an i18n key, none equal to the raw enum', () => {
    const labels = (ar as { bookings: { sourceLabels: Record<string, string> } }).bookings.sourceLabels
    for (const value of REAL_SOURCE_VALUES) {
      expect(labels[value]).toBeTruthy()
      expect(labels[value]).not.toBe(value)
    }
  })

  it('English and Arabic resources define the exact same set of source keys (no drift between locales)', () => {
    const enKeys = Object.keys((en as { bookings: { sourceLabels: Record<string, string> } }).bookings.sourceLabels).sort()
    const arKeys = Object.keys((ar as { bookings: { sourceLabels: Record<string, string> } }).bookings.sourceLabels).sort()
    expect(enKeys).toEqual(arKeys)
  })
})

describe('i18n resources: bookings.completionSourceLabels', () => {
  it('every real completion_source value (manual/automatic) is localized in both languages', () => {
    const enLabels = (en as { bookings: { completionSourceLabels: Record<string, string> } }).bookings.completionSourceLabels
    const arLabels = (ar as { bookings: { completionSourceLabels: Record<string, string> } }).bookings.completionSourceLabels
    for (const value of REAL_COMPLETION_SOURCE_VALUES) {
      expect(enLabels[value]).toBeTruthy()
      expect(arLabels[value]).toBeTruthy()
    }
  })
})

describe('BOOKING_STATUS_LABELS / BOOKING_STATUS_TONE: completed status is fully wired (regression guard)', () => {
  it('completed has a real Arabic-fallback label, distinct from the raw enum', () => {
    expect(BOOKING_STATUS_LABELS.completed).toBe('مكتمل')
  })
  it('completed has a defined semantic tone', () => {
    expect(BOOKING_STATUS_TONE.completed).toBe('neutral')
  })
  it('every real status value has both a label and a tone defined', () => {
    for (const value of REAL_STATUS_VALUES) {
      expect(BOOKING_STATUS_LABELS[value]).toBeTruthy()
      expect(BOOKING_STATUS_TONE[value]).toBeTruthy()
    }
  })
})
