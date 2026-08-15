// Shared domain types for Phase 4 — Customers, Players, Guardians.

export interface CustomerRow {
  id: string
  fullName: string
  mobileDisplay: string | null
  email: string | null
  whatsapp: string | null
}

export interface PlayerRow {
  id: string
  fullName: string
  dateOfBirth: string | null
  gender: string | null
  status: string
}

export interface GuardianLinkRow {
  id: string
  customerId: string
  playerId: string
  customerName: string
  relationship: string
  isPrimary: boolean
}
