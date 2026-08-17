import type { GatewayName, PaymentGateway } from './PaymentGateway'
import { StripeGateway } from './StripeGateway'
import { PayPalGateway } from './PayPalGateway'

export type { GatewayName, PaymentGateway, CheckoutSession, GatewayCheckoutResult } from './PaymentGateway'
export { GatewayNotConnectedError } from './PaymentGateway'

/** Resolves the PaymentGateway implementation for a given gateway name. The only place this codebase decides "stripe -> StripeGateway" -- callers never import a concrete gateway class directly. */
export function getPaymentGateway(name: GatewayName): PaymentGateway {
  switch (name) {
    case 'stripe':
      return new StripeGateway()
    case 'paypal':
      return new PayPalGateway()
  }
}
