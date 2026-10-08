// Row shapes returned by the rentals RPCs (20261007100000_rentals_module.sql).

export interface RentalSpaceRow {
  id: string
  branch_id: string
  branch_name: string
  name: string
  space_type: string
  custom_type_label: string | null
  description: string | null
  area_sqm: number | null
  capacity: number | null
  default_rent_cycle: string | null
  default_rent_amount: number | null
  allow_overlapping_contracts: boolean
  online_booking?: boolean
  status: 'active' | 'inactive' | 'archived'
  created_at: string
  active_contracts_count: number
  current_contract: { id: string; contract_number: string; customer_name: string; end_date: string } | null
  next_contract_start: string | null
}

export interface RentalContractRow {
  id: string
  contract_number: string
  space_id: string
  space_name: string
  space_type: string
  custom_type_label: string | null
  branch_id: string
  branch_name: string
  customer_id: string
  customer_name: string
  customer_mobile: string | null
  rent_cycle: string
  custom_cycle_value: number | null
  custom_cycle_unit: string | null
  cycles_count: number
  cycle_amount: number
  total_rent: number
  security_deposit: number
  deposit_held: number
  deposit_settled: boolean
  annual_increase_pct: number
  start_date: string
  end_date: string
  start_time: string | null
  end_time: string | null
  termination_date: string | null
  renewed_from_contract_id: string | null
  renewed: boolean
  status: 'active' | 'terminated' | 'cancelled'
  display_status: 'active' | 'upcoming' | 'expired' | 'terminated' | 'cancelled'
  invoiced: number
  paid: number
  outstanding: number
  overdue_amount: number
  overdue_count: number
  next_due_date: string | null
  created_at: string
}

export interface RentalInstallmentRow {
  id: string
  kind: 'rent' | 'deposit' | 'late_fee' | 'utility'
  sequence: number
  period_start: string
  period_end: string
  due_date: string
  amount: number
  invoice_id: string | null
  invoice_number: string | null
  invoice_status: string | null
  status: 'scheduled' | 'invoiced' | 'cancelled'
  paid: number
  outstanding: number
  payment_state: string
}

export interface RentalContractDetail {
  contract: {
    id: string
    contract_number: string
    rent_cycle: string
    custom_cycle_value: number | null
    custom_cycle_unit: string | null
    cycles_count: number
    cycle_amount: number
    total_rent: number
    security_deposit: number
    start_date: string
    end_date: string
    start_time: string | null
    end_time: string | null
    annual_increase_pct: number
    renewed_from_contract_id: string | null
    deposit_refunded: number
    deposit_kept: number
    deposit_settled_at: string | null
    deposit_settlement_note: string | null
    schedule_anchor: string | null
    prorated_first: boolean
    status: 'active' | 'terminated' | 'cancelled'
    notes: string | null
    termination_date: string | null
    termination_reason: string | null
    cancel_reason: string | null
    created_at: string
  }
  display_status: string
  today: string
  club: { name: string; name_ar: string | null; logo_url: string | null } | null
  space: {
    id: string; name: string; space_type: string; custom_type_label: string | null; branch_name: string
    branch_address: string | null; area_sqm: number | null; capacity: number | null
  }
  customer: { id: string; full_name: string; mobile_display: string | null; national_id: string | null; address: string | null }
  renewed_from: { id: string; contract_number: string } | null
  renewed_to: { id: string; contract_number: string } | null
  installments: RentalInstallmentRow[]
  totals: {
    scheduled_total: number
    invoiced: number
    paid: number
    outstanding: number
    not_invoiced: number
    overdue: number
    late_fees: number
    deposit_collected: number
    deposit_held: number
    deposit_refunded: number
    deposit_kept: number
  }
}

export interface RentalReport {
  spaces_total: number
  spaces_occupied_today: number
  active_contracts: number
  new_contracts_in_range: number
  contract_value_in_range: number
  collected_in_range: number
  utilities_collected_in_range?: number
  vat_collected_in_range?: number
  deposits_collected_in_range: number
  late_fees_in_range: number
  expenses_in_range: number
  net_in_range: number
  due_in_range: number
  outstanding_total: number
  overdue_total: number
  overdue_count: number
  not_invoiced_due_count: number
  deposits_held: number
  deposits_refunded: number
  deposits_kept: number
  by_space: {
    space_id: string
    space_name: string
    space_type: string
    custom_type_label: string | null
    occupied_today: boolean
    collected: number
    expenses: number
    net: number
    outstanding: number
  }[]
  by_cycle: { rent_cycle: string; contracts: number; value: number }[]
  overdue_rows: {
    installment_id: string
    contract_id: string
    contract_number: string
    customer_name: string
    space_name: string
    kind: 'rent' | 'deposit' | 'late_fee' | 'utility'
    sequence: number
    due_date: string
    amount: number
    outstanding: number
    payment_state: string
    invoice_id: string | null
  }[]
  expiring_soon: {
    contract_id: string
    contract_number: string
    customer_name: string
    space_name: string
    end_date: string
    renewed: boolean
  }[]
}

export interface RentalSettings {
  auto_issue_invoices: boolean
  issue_days_before: number
  late_fee_type: 'none' | 'fixed' | 'percent'
  late_fee_value: number
  late_fee_grace_days: number
  whatsapp_reminders_enabled: boolean
  reminder_days_before: number
  vat_rate: number
  expiry_alert_days: number
  whatsapp_templates_live: boolean
}

export interface RentalSpaceExpense {
  id: string
  amount: number
  description: string
  expense_date: string
  payment_method: string
  paid_to: string | null
  status: string
}

export interface PortalRentalContract {
  id: string
  club_id: string
  club_name: string
  club_name_ar: string | null
  contract_number: string
  space_name: string
  space_type: string
  custom_type_label: string | null
  branch_name: string
  rent_cycle: string
  custom_cycle_value: number | null
  custom_cycle_unit: string | null
  start_date: string
  end_date: string
  start_time: string | null
  end_time: string | null
  termination_date: string | null
  status: 'active' | 'terminated' | 'cancelled'
  security_deposit: number
  installments: {
    kind: 'rent' | 'deposit' | 'late_fee' | 'utility'
    sequence: number
    period_start: string
    period_end: string
    due_date: string
    amount: number
    paid: number
    outstanding: number
    payment_state: string
    invoice_number: string | null
    invoice_id?: string | null
  }[]
}

// RENTALS v3 (20261009100000_rentals_v3.sql)
export interface RentalBookingRequest {
  id: string
  space_id: string
  space_name: string
  customer_id: string
  customer_name: string
  customer_mobile: string | null
  booking_date: string
  start_time: string
  hours: number
  hourly_rate: number | null
  notes: string | null
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  contract_id: string | null
  decision_note: string | null
  created_at: string
  conflict: boolean
}

export interface RentalContractDocument {
  id: string
  doc_type: 'signed_contract' | 'id_document' | 'checkin_photo' | 'checkout_photo' | 'receipt' | 'other'
  file_name: string
  storage_path: string
  mime_type: string | null
  size_bytes: number | null
  created_at: string
}

export interface RentalMeter {
  id: string
  meter_type: 'electricity' | 'water' | 'gas' | 'other'
  label: string | null
  unit_price: number
  last_reading: number
  active: boolean
  readings: {
    id: string
    reading_date: string
    previous_reading: number
    current_reading: number
    consumption: number
    amount: number
    invoice_id: string | null
  }[]
}

export interface RentalStaffAlert {
  id: string
  kind: 'contract_expiring'
  days_left: number
  end_date: string
  created_at: string
  read_at: string | null
  contract_id: string
  contract_number: string
  customer_name: string
  space_name: string
  renewed: boolean
}

export interface PortalBookableSpace {
  id: string
  name: string
  space_type: string
  custom_type_label: string | null
  description: string | null
  capacity: number | null
  branch_name: string
  hourly_rate: number | null
  busy: { date: string; end_date: string; start_time: string | null; end_time: string | null }[]
}

export interface PortalBookingRequest {
  id: string
  club_id: string
  space_name: string
  booking_date: string
  start_time: string
  hours: number
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  notes: string | null
  decision_note: string | null
  created_at: string
  hourly_rate: number | null
}
