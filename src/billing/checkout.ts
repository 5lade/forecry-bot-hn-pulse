/**
 * Real Stripe-backed BillingClient. Replaces StubBillingClient (p1-006).
 *
 * Wraps the `stripe` SDK behind the same `BillingClient` interface used by
 * the Telegram bot's /upgrade and /cancel commands. The webhook handler
 * (see ./webhook.ts) is what actually flips users.tier — this module only
 * mints checkout/billing-portal URLs.
 */

import Stripe from "stripe";
import type {
  BillingClient,
  BillingPortalSession,
  CheckoutSession,
} from "../bot/stripe.js";

export interface StripeBillingClientOptions {
  stripe: Pick<Stripe, "checkout" | "billingPortal">;
  pulsePriceId: string;
}

/**
 * Concrete BillingClient that talks to Stripe.
 *
 * /upgrade flow always sells the entry-level "pulse" plan; users who want
 * the pulse-pro upgrade go through the billing portal once they have an
 * active customer. Keeping checkout simple matches Spec.md §5 ("/upgrade —
 * Stripe checkout link").
 */
export class StripeBillingClient implements BillingClient {
  private readonly stripe: Pick<Stripe, "checkout" | "billingPortal">;
  private readonly pulsePriceId: string;

  constructor(opts: StripeBillingClientOptions) {
    this.stripe = opts.stripe;
    this.pulsePriceId = opts.pulsePriceId;
  }

  async createCheckoutSession(args: {
    telegramUserId: number;
    userId: string;
    publicUrl: string;
  }): Promise<CheckoutSession> {
    const base = args.publicUrl.replace(/\/$/, "");
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: this.pulsePriceId, quantity: 1 }],
      success_url: `${base}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/billing/cancel`,
      client_reference_id: args.userId,
      subscription_data: {
        trial_period_days: 7,
        metadata: {
          telegram_user_id: String(args.telegramUserId),
          user_id: args.userId,
        },
      },
      metadata: {
        telegram_user_id: String(args.telegramUserId),
        user_id: args.userId,
      },
    });

    if (!session.url) {
      throw new Error("Stripe returned a checkout session without a URL");
    }
    return { id: session.id, url: session.url };
  }

  async createBillingPortalSession(args: {
    customerId: string;
    publicUrl: string;
  }): Promise<BillingPortalSession> {
    const base = args.publicUrl.replace(/\/$/, "");
    const session = await this.stripe.billingPortal.sessions.create({
      customer: args.customerId,
      return_url: `${base}/billing/return`,
    });
    return { id: session.id, url: session.url };
  }
}

/**
 * Default Stripe SDK factory. Tests inject their own Stripe-shaped object
 * via StripeBillingClient's constructor instead of constructing one here.
 */
export function makeStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, { apiVersion: "2025-02-24.acacia" });
}
