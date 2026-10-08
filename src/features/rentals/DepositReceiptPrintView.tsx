import { useTranslation } from 'react-i18next'
import { formatMoney } from '@/lib/domain/billing'
import { useDirection } from '@/app/providers/DirectionProvider'
import type { RentalContractDetail } from './types'

// Printable security-deposit settlement receipt (A4): deposit collected,
// refunded to the tenant, kept by the club and why -- signed by both
// parties at hand-over. Same .print-target mechanism as the lease print.

export function DepositReceiptPrintView({ detail }: { detail: RentalContractDetail }) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const c = detail.contract
  const money = (n: number) => formatMoney(Number(n), 'EGP', locale)
  const clubName = (locale === 'ar' ? detail.club?.name_ar : null) || detail.club?.name || ''
  const collected = Number(c.deposit_refunded) + Number(c.deposit_kept)

  return (
    <div data-print-size="a4" className="print-target visible-for-print hidden text-sm leading-relaxed text-black print:block">
      <div className="mb-4 flex items-start justify-between border-b border-black pb-3">
        <div>
          <p className="text-lg font-bold">{clubName}</p>
          <p className="text-xs">{detail.space.branch_name}{detail.space.branch_address ? ` — ${detail.space.branch_address}` : ''}</p>
        </div>
        {detail.club?.logo_url && <img src={detail.club.logo_url} alt="" className="h-14 w-auto" />}
      </div>
      <h1 className="mb-1 text-center text-xl font-bold">{t('rentals.depositReceipt.title')}</h1>
      <p className="mb-4 text-center text-xs">
        {t('rentals.contracts.number')}: <bdi className="tabular-nums">{c.contract_number}</bdi>
        {c.deposit_settled_at && <> · {t('rentals.depositReceipt.date', { date: c.deposit_settled_at.slice(0, 10) })}</>}
      </p>

      <p className="mb-1">{t('rentals.print.lessee')}: {detail.customer.full_name}{detail.customer.national_id ? ` — ${t('rentals.print.nationalId')}: ${detail.customer.national_id}` : ''}</p>
      <p className="mb-4">{t('rentals.print.subject')}: {detail.space.name}</p>

      <table className="mb-4 w-full border-collapse">
        <tbody>
          <tr><td className="border border-black p-2">{t('rentals.depositReceipt.collected')}</td><td className="border border-black p-2 tabular-nums">{money(collected)}</td></tr>
          <tr><td className="border border-black p-2 font-bold">{t('rentals.depositReceipt.refunded')}</td><td className="border border-black p-2 font-bold tabular-nums">{money(c.deposit_refunded)}</td></tr>
          <tr><td className="border border-black p-2">{t('rentals.depositReceipt.kept')}</td><td className="border border-black p-2 tabular-nums">{money(c.deposit_kept)}</td></tr>
          {c.deposit_settlement_note && (
            <tr><td className="border border-black p-2">{t('rentals.depositReceipt.reason')}</td><td className="border border-black p-2">{c.deposit_settlement_note}</td></tr>
          )}
        </tbody>
      </table>
      <p className="mb-10">{t('rentals.depositReceipt.statement', { amount: money(c.deposit_refunded) })}</p>

      <div className="grid grid-cols-2 gap-8 text-center">
        <div>
          <p className="font-bold">{t('rentals.print.lessor')}</p>
          <p className="mt-10 border-t border-black pt-1 text-xs">{t('rentals.print.signature')}</p>
        </div>
        <div>
          <p className="font-bold">{t('rentals.depositReceipt.receiver')}</p>
          <p className="mt-10 border-t border-black pt-1 text-xs">{t('rentals.print.signature')}</p>
        </div>
      </div>
    </div>
  )
}
