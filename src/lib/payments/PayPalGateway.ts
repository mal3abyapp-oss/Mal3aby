import { supabase } from '@/lib/supabase/client'
import { GatewayNotConnectedError, type GatewayCheckoutResult, type PaymentGateway } from './PaymentGateway'

/**
 * PayPalGateway -- the ONLY file allowed to reference PayPal-specific
 * concepts (Orders API, client ID). Mirrors StripeGateway.ts exactly
 * -- same PaymentGateway interface, same "real DB-side staging is
 * real, the actual external API call is an explicit TODO behind a
 * server-side Edge Function" split. See StripeGateway.ts's module
 * comment and PaymentGateway.ts for the full rationale; not repeated
 * here to avoid the two files drifting into different explanations of
 * the same architecture decision.
 */
export class PayPalGateway implements PaymentGateway {
  readonly name = 'paypal' as const

  async startCheckout(invoiceId: string, amount: number): Promise<GatewayCheckoutResult> {
    const { data: configRow, error: configError } = await supabase
      .from('payment_gateway_configs')
      .select('enabled, public_key')
      .eq('gateway', 'paypal')
      .single()

    if (configError || !configRow?.enabled || !configRow.public_key) {
      return { session: null, error: new GatewayNotConnectedError('paypal').message }
    }

    const { data: transactionId, error: rpcError } = await supabase.rpc('start_gateway_checkout', {
      p_invoice_id: invoiceId,
      p_gateway: 'paypal',
      p_amount: amount,
    })
    if (rpcError) {
      return { session: null, error: rpcError.message }
    }

    // TODO(task #89 follow-up, requires a real PayPal business
    // account): call a Supabase Edge Function (e.g.
    // `paypal-create-order`) that holds the PayPal CLIENT SECRET
    // server-side, creates a real Order via PayPal's Orders API with
    // transactionId as a custom_id/reference, and returns the
    // approval URL. That Edge Function is the only place a PayPal
    // client secret may ever be read. Until it exists, this honestly
    // reports "not connected" -- the real staging row (transactionId)
    // still exists in payment_gateway_transactions for later
    // reconciliation/cleanup.
    return {
      session: null,
      error: `${new GatewayNotConnectedError('paypal').message} (staging transaction ${transactionId} was recorded)`,
    }
  }

  async verifyWebhook(): Promise<{ transactionReference: string; success: boolean } | null> {
    // TODO(task #89 follow-up): PayPal webhook verification (the
    // Verify Webhook Signature API call) MUST run inside a Supabase
    // Edge Function -- never in browser code. Never called from any
    // browser code path today.
    throw new GatewayNotConnectedError('paypal')
  }
}
