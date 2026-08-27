import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2, CheckCircle2, XCircle, Clock } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/supabase/client'

/**
 * GatewayReturnPage -- the hosted-checkout REDIRECT LANDING page a
 * customer/staff member lands on after Stripe Checkout (success_url /
 * cancel_url, set by stripe-create-checkout-session).
 *
 * HARD RULE (governing directive, item 5): "redirect result is never
 * authoritative". This component contains ZERO write path to
 * payments/payment_gateway_transactions -- it never calls
 * record_gateway_payment_service, mark_gateway_transaction_failed_service,
 * or any other mutating RPC. Its ONLY data access is
 * get_gateway_transaction_status(), a read-only (`language sql`,
 * `stable`) RPC. Even though ?outcome=success is present in the URL
 * (Stripe's own redirect query param, fully attacker-replayable --
 * anyone can hand-craft this URL with any transaction_id and
 * outcome=success), this component NEVER treats that URL param as
 * proof of payment. The ONLY thing that can ever change
 * payment_gateway_transactions.status is the webhook-driven
 * record_gateway_payment_service/mark_gateway_transaction_failed_service
 * pair running server-side after independent signature verification.
 * This page only ever *displays* whatever the server-side status
 * already is, polling for it to change if it's still 'pending'.
 */
export function GatewayReturnPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const transactionId = searchParams.get('transaction_id')
  const outcomeParam = searchParams.get('outcome') // display hint ONLY -- never trusted for state.

  const [status, setStatus] = useState<'loading' | 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'error'>('loading')
  const [failureReason, setFailureReason] = useState<string | null>(null)
  const [invoiceId, setInvoiceId] = useState<string | null>(null)

  useEffect(() => {
    if (!transactionId) {
      setStatus('error')
      return
    }

    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    const MAX_ATTEMPTS = 20 // ~60s of polling at the backoff schedule below -- generous for webhook delivery latency without polling forever.

    async function poll() {
      attempts += 1
      // get_gateway_transaction_status is READ-ONLY (language sql,
      // stable) -- this call cannot, even in principle, write
      // anything. It re-derives club/invoice.view authorization
      // server-side on every call, same as every other RPC in this
      // codebase.
      const { data, error } = await supabase.rpc('get_gateway_transaction_status', {
        p_transaction_id: transactionId,
      })

      if (cancelled) return

      if (error || !data || data.length === 0) {
        setStatus('error')
        return
      }

      const row = data[0] as { status: string; failure_reason: string | null; invoice_id: string }
      setInvoiceId(row.invoice_id)

      if (row.status === 'succeeded') {
        setStatus('succeeded')
        return
      }
      if (row.status === 'failed') {
        setStatus('failed')
        setFailureReason(row.failure_reason)
        return
      }
      if (row.status === 'cancelled') {
        setStatus('cancelled')
        return
      }

      // Still 'pending' server-side -- the webhook has not (yet)
      // confirmed this transaction, regardless of what the redirect
      // URL's ?outcome= claims. Keep polling with backoff until a
      // real server-side state change arrives or we give up waiting
      // (the customer can always check Finance > Payments later; the
      // invoice's real status is never lost, only this page's live
      // wait times out).
      setStatus('pending')
      if (attempts < MAX_ATTEMPTS) {
        pollTimer = setTimeout(poll, Math.min(1000 * attempts, 5000))
      }
    }

    poll()

    return () => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
    }
  }, [transactionId])

  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center px-4 py-16">
      <Card className="w-full">
        <CardHeader className="items-center text-center">
          <CardTitle>{t('finance.gatewayReturn.title', 'Payment status')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 text-center">
          {(status === 'loading' || status === 'pending') && (
            <>
              <Loader2 className="h-10 w-10 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {t('finance.gatewayReturn.pending', 'We are confirming your payment with the provider. This can take a few seconds.')}
              </p>
              {outcomeParam === 'cancelled' && (
                <p className="text-xs text-muted-foreground">
                  {t('finance.gatewayReturn.cancelledHint', 'It looks like checkout was cancelled -- confirming the final status now.')}
                </p>
              )}
            </>
          )}

          {status === 'succeeded' && (
            <>
              <CheckCircle2 className="h-10 w-10 text-green-600" />
              <p className="text-sm font-medium">{t('finance.gatewayReturn.succeeded', 'Payment confirmed.')}</p>
            </>
          )}

          {status === 'failed' && (
            <>
              <XCircle className="h-10 w-10 text-destructive" />
              <p className="text-sm font-medium">{t('finance.gatewayReturn.failed', 'This payment was not completed.')}</p>
              {failureReason && <p className="text-xs text-muted-foreground">{failureReason}</p>}
            </>
          )}

          {status === 'cancelled' && (
            <>
              <XCircle className="h-10 w-10 text-muted-foreground" />
              <p className="text-sm font-medium">{t('finance.gatewayReturn.cancelledFinal', 'Checkout was cancelled.')}</p>
            </>
          )}

          {status === 'error' && (
            <>
              <Clock className="h-10 w-10 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                {t('finance.gatewayReturn.error', 'We could not load this payment\'s status. Please check Finance for the latest status.')}
              </p>
            </>
          )}

          <Button
            className="mt-2"
            variant={status === 'succeeded' ? 'default' : 'outline'}
            onClick={() => navigate(invoiceId ? `/app/finance/payments?invoice=${invoiceId}` : '/app/finance/payments')}
          >
            {t('finance.gatewayReturn.goToInvoice', 'Go to Finance')}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
