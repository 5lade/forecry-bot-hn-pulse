/**
 * Thin Stripe checkout/billing-portal helper used by the Telegram bot.
 *
 * Real Stripe webhook handling lands in p1-007. This module only covers the
 * bot-side flows: starting a checkout from /upgrade and returning a billing
 * portal URL from /cancel. Both flows are guarded behind a `BillingClient`
 * interface so tests can substitute a fake without hitting the network.
 */

export interface CheckoutSession {
  id: string;
  url: string;
}

export interface BillingPortalSession {
  id: string;
  url: string;
}

export interface BillingClient {
  createCheckoutSession(args: {
    telegramUserId: number;
    userId: string;
    publicUrl: string;
  }): Promise<CheckoutSession>;

  createBillingPortalSession(args: {
    customerId: string;
    publicUrl: string;
  }): Promise<BillingPortalSession>;
}

export class BillingNotConfiguredError extends Error {
  constructor(message = "billing is not configured") {
    super(message);
    this.name = "BillingNotConfiguredError";
  }
}

/**
 * Default fallback used when Stripe is not yet wired (pre p1-007).
 * It hands back a placeholder /upgrade URL so the bot has a working flow,
 * but never attempts to talk to Stripe.
 */
export class StubBillingClient implements BillingClient {
  constructor(private readonly publicUrl: string) {}

  async createCheckoutSession(args: {
    telegramUserId: number;
    userId: string;
  }): Promise<CheckoutSession> {
    const url = `${this.publicUrl.replace(/\/$/, "")}/billing/checkout?uid=${encodeURIComponent(args.userId)}`;
    return { id: `stub_${args.userId}`, url };
  }

  async createBillingPortalSession(args: {
    customerId: string;
  }): Promise<BillingPortalSession> {
    const url = `${this.publicUrl.replace(/\/$/, "")}/billing/portal?cust=${encodeURIComponent(args.customerId)}`;
    return { id: `stub_${args.customerId}`, url };
  }
}
