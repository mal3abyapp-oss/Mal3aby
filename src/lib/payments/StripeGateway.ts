import { supabase } from '@/lib/supabase/client'
import { GatewayNotConnectedError, type GatewayCheckoutResult, type PaymentGateway } from './PaymentGateway'

/**
 * StripeGateway -- the ONLY file allowed to reference Stripe-specific
 * concepts (Checkout Sessions, publishable keys). Everything outside
 * this file talks to the PaymentGateway interface only.
 *
 * Task #88 scope: architecture, not a live integration (see
 * PaymentGateway.ts's module comment). This class is real, working
 * TypeScript -- it correctly calls the real start_gateway_checkout()
 * DB RPC and correctly validates the club has a real publishable key
 * configured -- but the actual "create a Stripe Checkout Session and
 * get a redirect URL" step requires a server-side secret key call,
 * which does not belong in browser code at all (a secret key shipped
 * to the browser is a direct financial compromise, not a theoretical
 * one). That step is marked with an explicit TODO and throws
 * GatewayNotConnectedError until a real Edge Function exists to make
 * it, rather than being stubbed out to fake a redirect URL that would
 * silently break in production.
 */
export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe' as const

  async startCheckout(invoiceId: string, amount: number): Promise<GatewayCheckoutResult> {
    const { data: publicKeyRow, error: configError } = await supabase
      .from('payment_gateway_configs')
      .select('enabled, public_key')
      .eq('gateway', 'stripe')
      .single()

    if (configError || !publicKeyRow?.enabled || !publicKeyRow.public_key) {
      return { session: null, error: new GatewayNotConnectedError('stripe').message }
    }

    // Creates the real DB-side staging row and validates the amount
    // against the real outstanding balance -- this part is fully real,
    // not a stub.
    const { data: transactionId, error: rpcError } = await supabase.rpc('start_gateway_checkout', {
      p_invoice_id: invoiceId,
      p_gateway: 'stripe',
      p_amount: amount,
    })
    if (rpcError) {
      return { session: null, error: rpcError.message }
    }

    // TODO(task #88 follow-up, requires a real Stripe account): call a
    // Supabase Edge Function (e.g. `stripe-create-checkout-session`)
    // that holds the Stripe SECRET key server-side, passes
    // transactionId as the Checkout Session's client_reference_id, and
    // returns session.url. That Edge Function is the only place a
    // Stripe secret key may ever be read -- never this file, never any
    // browser code. Until that function exists, this honestly reports
    // "not connected" rather than fabricating a redirect URL -- the
    // real staging row (transactionId) still exists in
    // payment_gateway_transactions for later reconciliation/cleanup.
    return {
      session: null,
      error: `${new GatewayNotConnectedError('stripe').message} (staging transaction ${transactionId} was recorded)`,
    }
  }

  async verifyWebhook(): Promise<{ transactionReference: string; success: boolean } | null> {
    // TODO(task #88 follow-up): Stripe webhook signature verification
    // (stripe.webhooks.constructEvent with the webhook signing secret)
    // MUST run inside a Supabase Edge Function -- the signing secret is
    // exactly as sensitive as an API key and must never be embedded in
    // browser code. This method exists on the interface so the calling
    // shape is already correct when that Edge Function is built; it is
    // never called from any browser code path today.
    throw new GatewayNotConnectedError('stripe')
  }
}
