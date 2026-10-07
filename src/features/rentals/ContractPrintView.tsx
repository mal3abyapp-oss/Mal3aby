import { useTranslation } from 'react-i18next'
import { formatMoney } from '@/lib/domain/billing'
import { useDirection } from '@/app/providers/DirectionProvider'
import { rentalSpaceTypeLabel, rentCycleLabel } from '@/lib/domain/rental'
import type { RentalContractDetail } from './types'

// Printable lease contract (A4). Hidden on screen and shown only when
// printing, through the shared .print-target / .visible-for-print rules
// in index.css (same mechanism as invoices and expense vouchers). The
// parties, the space, the term, the rent schedule and the deposit come
// straight from get_rental_contract_detail; the free-text notes carry
// any extra terms the club agreed with the tenant.

export function ContractPrintView({ detail }: { detail: RentalContractDetail }) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const c = detail.contract
  const money = (n: number) => formatMoney(Number(n), 'EGP', locale)
  const clubName = (locale === 'ar' ? detail.club?.name_ar : null) || detail.club?.name || ''
  const rents = detail.installments.filter((i) => i.kind === 'rent' && i.status !== 'cancelled')
  const isHourly = c.rent_cycle === 'hourly'

  return (
    <div data-print-size="a4" className="print-target visible-for-print hidden text-sm leading-relaxed text-black print:block">
      <div className="mb-4 flex items-start justify-between border-b border-black pb-3">
        <div>
          <p className="text-lg font-bold">{clubName}</p>
          <p className="text-xs">{detail.space.branch_name}{detail.space.branch_address ? ` — ${detail.space.branch_address}` : ''}</p>
        </div>
        {detail.club?.logo_url && <img src={detail.club.logo_url} alt="" className="h-14 w-auto" />}
      </div>

      <h1 className="mb-1 text-center text-xl font-bold">{isHourly ? t('rentals.print.bookingTitle') : t('rentals.print.title')}</h1>
      <p className="mb-4 text-center text-xs">
        {t('rentals.contracts.number')}: <bdi className="tabular-nums">{c.contract_number}</bdi> · {t('rentals.print.issuedOn', { date: c.created_at.slice(0, 10) })}
      </p>

      <section className="mb-3">
        <p className="font-bold">{t('rentals.print.parties')}</p>
        <p>{t('rentals.print.lessor')}: {clubName}</p>
        <p>
          {t('rentals.print.lessee')}: {detail.customer.full_name}
          {detail.customer.national_id ? ` — ${t('rentals.print.nationalId')}: ${detail.customer.national_id}` : ''}
          {detail.customer.mobile_display ? ` — ${detail.customer.mobile_display}` : ''}
        </p>
        {detail.customer.address && <p>{t('rentals.print.address')}: {detail.customer.address}</p>}
      </section>

      <section className="mb-3">
        <p className="font-bold">{t('rentals.print.subject')}</p>
        <p>
          {detail.space.name} ({rentalSpaceTypeLabel(t, detail.space.space_type, detail.space.custom_type_label)})
          {detail.space.area_sqm ? ` — ${t('rentals.spaces.area')}: ${detail.space.area_sqm}` : ''}
          {detail.space.capacity ? ` — ${t('rentals.spaces.capacity')}: ${detail.space.capacity}` : ''}
        </p>
      </section>

      <section className="mb-3">
        <p className="font-bold">{t('rentals.print.term')}</p>
        {isHourly ? (
          <p>{t('rentals.print.hourlyTerm', { date: c.start_date, from: c.start_time?.slice(0, 5), to: c.end_time?.slice(0, 5), hours: c.cycles_count })}</p>
        ) : (
          <p>{t('rentals.print.termText', { start: c.start_date, end: c.end_date, count: c.cycles_count, cycle: rentCycleLabel(t, c.rent_cycle, c.custom_cycle_value, c.custom_cycle_unit) })}</p>
        )}
      </section>

      <section className="mb-3">
        <p className="font-bold">{t('rentals.print.rent')}</p>
        <p>
          {isHourly
            ? t('rentals.print.hourlyRent', { rate: money(c.cycle_amount), total: money(c.total_rent) })
            : t('rentals.print.rentText', { amount: money(c.cycle_amount), total: money(c.total_rent) })}
        </p>
        {Number(c.annual_increase_pct) > 0 && <p>{t('rentals.print.increaseText', { pct: Number(c.annual_increase_pct) })}</p>}
        {Number(c.security_deposit) > 0 && <p>{t('rentals.print.depositText', { amount: money(c.security_deposit) })}</p>}
      </section>

      {rents.length > 1 && (
        <table className="mb-3 w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="border border-black p-1 text-start">#</th>
              <th className="border border-black p-1 text-start">{t('rentals.detail.periodCol')}</th>
              <th className="border border-black p-1 text-start">{t('rentals.detail.dueDate')}</th>
              <th className="border border-black p-1 text-start">{t('rentals.detail.amount')}</th>
            </tr>
          </thead>
          <tbody>
            {rents.map((i) => (
              <tr key={i.id}>
                <td className="border border-black p-1 tabular-nums">{i.sequence}</td>
                <td className="border border-black p-1 tabular-nums"><bdi>{i.period_start} → {i.period_end}</bdi></td>
                <td className="border border-black p-1 tabular-nums">{i.due_date}</td>
                <td className="border border-black p-1 tabular-nums">{money(i.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <section className="mb-3">
        <p className="font-bold">{t('rentals.print.terms')}</p>
        <ol className="list-decimal ps-5">
          <li>{t('rentals.print.clause1')}</li>
          <li>{t('rentals.print.clause2')}</li>
          <li>{t('rentals.print.clause3')}</li>
          {c.notes && <li className="whitespace-pre-wrap">{c.notes}</li>}
        </ol>
      </section>

      <div className="mt-10 grid grid-cols-2 gap-8 text-center">
        <div>
          <p className="font-bold">{t('rentals.print.lessor')}</p>
          <p className="mt-10 border-t border-black pt-1 text-xs">{t('rentals.print.signature')}</p>
        </div>
        <div>
          <p className="font-bold">{t('rentals.print.lessee')}</p>
          <p className="mt-10 border-t border-black pt-1 text-xs">{t('rentals.print.signature')}</p>
        </div>
      </div>
    </div>
  )
}
