/**
 * PaymentGateway -- the adapter boundary for external payment
 * gateways (Stripe, PayPal). Same pattern already proven in this
 * codebase for WhatsApp (WhatsAppProvider/BaileysProvider): a narrow
 * interface first, real provider-specific code only inside a class
 * implementing it, so business logic (the checkout flow, the invoice
 * detail page) never imports @stripe/stripe-js or a PayPal SDK
 * directly and a gateway can be added/swapped without touching
 * anything outside this directory.
 *
 * Master Payment Directive task #88/#89 scope: this is the
 * ARCHITECTURE only. No live Stripe/PayPal account exists for this
 * project, so no implementation here makes a real external API call --
 * StripeGateway/PayPalGateway are structured skeletons that show
 * exactly where real SDK calls would go, each throwing a clear
 * "not yet connected" error rather than silently no-op'ing or faking
 * success. Wiring in a real account later means filling in those
 * specific call sites plus a webhook-handling Edge Function -- never a
 * redesign of this interface or of record_payment()/invoices, which
 * remain the single source of truth for "is this invoice paid" exactly
 * as they are today (see start_gateway_checkout(), the DB-side
 * counterpart, in supabase/migrations/20260817070947_payment_gateway_architecture.sql).
 */

export type GatewayName = 'stripe' | 'paypal'

export interface CheckoutSession {
  /** The payment_gateway_transactions.id this session corresponds to (DB-side staging row, created via start_gateway_checkout()). */
  transactionId: string
  /** URL to redirect the customer to for hosted checkout (Stripe Checkout / PayPal order approval). */
  redirectUrl: string
}

export interface GatewayCheckoutResult {
  session: CheckoutSession | null
  error?: string
}

/**
 * One PaymentGateway instance is scoped to a single club's
 * configuration (its public key + whichever server-side credentials
 * an Edge Function resolves for it) -- never a shared, cross-tenant
 * instance, matching this codebase's tenant-isolation convention
 * everywhere else (WhatsApp's TenantConnectionManager, notification
 * queue scoping).
 */
export interface PaymentGateway {
  readonly name: GatewayName

  /**
   * Starts a hosted checkout for the given invoice/amount. Expected
   * real implementation: call start_gateway_checkout() (DB RPC) to
   * create the staging row and validate the amount against the real
   * outstanding balance, then call the gateway's own API (Stripe
   * Checkout Sessions / PayPal Orders) to get a redirect URL -- that
   * second call requires a server-side secret key and MUST happen in
   * an Edge Function, never directly from the browser (a secret key
   * embedded in client code is a real, direct financial compromise).
   */
  startCheckout(invoiceId: string, amount: number): Promise<GatewayCheckoutResult>

  /**
   * Verifies a webhook payload's authenticity (signature check against
   * the gateway's webhook signing secret) and returns the transaction
   * reference it refers to, or null if the payload is not
   * authentically from this gateway. This MUST run server-side only
   * (an Edge Function) -- a client-side "payment succeeded" callback
   * from the browser is trivially spoofable and must never be trusted
   * to mark an invoice paid (this is exactly why
   * payment_gateway_transactions.status can only be set by a
   * SECURITY DEFINER RPC the client cannot call directly, not by any
   * client write).
   */
  verifyWebhook(rawBody: string, signatureHeader: string): Promise<{ transactionReference: string; success: boolean } | null>
}

/** Thrown by a gateway skeleton when a real account/API key has not been configured -- an honest, explicit failure rather than a silent no-op or a faked success. */
export class GatewayNotConnectedError extends Error {
  constructor(gateway: GatewayName) {
    super(`${gateway} is not connected for this club -- no real API credentials are configured. This is expected until a real ${gateway} account is set up (task #88/#89 shipped the architecture, not a live integration).`)
    this.name = 'GatewayNotConnectedError'
  }
}
