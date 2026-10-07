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
  start_date: string
  end_date: string
  termination_date: string | null
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
  kind: 'rent' | 'deposit'
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
    status: 'active' | 'terminated' | 'cancelled'
    notes: string | null
    termination_date: string | null
    termination_reason: string | null
    cancel_reason: string | null
  }
  display_status: string
  space: { id: string; name: string; space_type: string; custom_type_label: string | null; branch_name: string }
  customer: { id: string; full_name: string; mobile_display: string | null }
  installments: RentalInstallmentRow[]
  totals: {
    scheduled_total: number
    invoiced: number
    paid: number
    outstanding: number
    not_invoiced: number
    overdue: number
  }
}

export interface RentalReport {
  spaces_total: number
  spaces_occupied_today: number
  active_contracts: number
  new_contracts_in_range: number
  contract_value_in_range: number
  collected_in_range: number
  due_in_range: number
  outstanding_total: number
  overdue_total: number
  overdue_count: number
  not_invoiced_due_count: number
  deposits_held: number
  by_space: {
    space_id: string
    space_name: string
    space_type: string
    custom_type_label: string | null
    occupied_today: boolean
    collected: number
    outstanding: number
  }[]
  by_cycle: { rent_cycle: string; contracts: number; value: number }[]
  overdue_rows: {
    installment_id: string
    contract_id: string
    contract_number: string
    customer_name: string
    space_name: string
    kind: 'rent' | 'deposit'
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
  }[]
}
