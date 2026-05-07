import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { StripeBillingClient } from "../checkout.js";

interface FakeStripeCalls {
  createCheckout: Array<Stripe.Checkout.SessionCreateParams>;
  createPortal: Array<Stripe.BillingPortal.SessionCreateParams>;
}

function makeFakeStripe(opts: {
  checkoutResponse?: Partial<Stripe.Checkout.Session>;
  portalResponse?: Partial<Stripe.BillingPortal.Session>;
  throwOn?: "checkout" | "portal";
}): { stripe: Pick<Stripe, "checkout" | "billingPortal">; calls: FakeStripeCalls } {
  const calls: FakeStripeCalls = { createCheckout: [], createPortal: [] };
  const stripe = {
    checkout: {
      sessions: {
        async create(
          params: Stripe.Checkout.SessionCreateParams,
        ): Promise<Stripe.Checkout.Session> {
          calls.createCheckout.push(params);
          if (opts.throwOn === "checkout") throw new Error("stripe down");
          return {
            id: "cs_test_abc",
            url: "https://checkout.stripe.com/test/abc",
            ...opts.checkoutResponse,
          } as Stripe.Checkout.Session;
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(
          params: Stripe.BillingPortal.SessionCreateParams,
        ): Promise<Stripe.BillingPortal.Session> {
          calls.createPortal.push(params);
          if (opts.throwOn === "portal") throw new Error("stripe down");
          return {
            id: "bps_test_abc",
            url: "https://billing.stripe.com/test/abc",
            ...opts.portalResponse,
          } as Stripe.BillingPortal.Session;
        },
      },
    },
  } as unknown as Pick<Stripe, "checkout" | "billingPortal">;
  return { stripe, calls };
}

describe("StripeBillingClient", () => {
  it("creates a subscription checkout with the configured pulse price id", async () => {
    const { stripe, calls } = makeFakeStripe({});
    const billing = new StripeBillingClient({
      stripe,
      pulsePriceId: "price_pulse_123",
    });
    const session = await billing.createCheckoutSession({
      telegramUserId: 9001,
      userId: "user-uuid-1",
      publicUrl: "https://hn.example/",
    });
    expect(session).toEqual({
      id: "cs_test_abc",
      url: "https://checkout.stripe.com/test/abc",
    });
    expect(calls.createCheckout).toHaveLength(1);
    const params = calls.createCheckout[0]!;
    expect(params.mode).toBe("subscription");
    expect(params.line_items?.[0]).toEqual({
      price: "price_pulse_123",
      quantity: 1,
    });
    expect(params.client_reference_id).toBe("user-uuid-1");
    expect(params.success_url).toContain("https://hn.example");
    expect(params.cancel_url).toContain("https://hn.example");
    expect(params.metadata).toMatchObject({
      telegram_user_id: "9001",
      user_id: "user-uuid-1",
    });
  });

  it("creates a billing portal session with the customer id", async () => {
    const { stripe, calls } = makeFakeStripe({});
    const billing = new StripeBillingClient({
      stripe,
      pulsePriceId: "price_pulse_123",
    });
    const portal = await billing.createBillingPortalSession({
      customerId: "cus_X",
      publicUrl: "https://hn.example",
    });
    expect(portal.url).toBe("https://billing.stripe.com/test/abc");
    expect(calls.createPortal).toHaveLength(1);
    expect(calls.createPortal[0]!.customer).toBe("cus_X");
    expect(calls.createPortal[0]!.return_url).toContain("https://hn.example");
  });

  it("propagates Stripe errors so the bot can show a friendly message", async () => {
    const { stripe } = makeFakeStripe({ throwOn: "checkout" });
    const billing = new StripeBillingClient({
      stripe,
      pulsePriceId: "price_pulse_123",
    });
    await expect(
      billing.createCheckoutSession({
        telegramUserId: 1,
        userId: "u",
        publicUrl: "https://x",
      }),
    ).rejects.toThrow("stripe down");
  });

  it("throws if Stripe returns a checkout session without a URL", async () => {
    const { stripe } = makeFakeStripe({
      checkoutResponse: { id: "cs_no_url", url: null },
    });
    const billing = new StripeBillingClient({
      stripe,
      pulsePriceId: "price_pulse_123",
    });
    await expect(
      billing.createCheckoutSession({
        telegramUserId: 1,
        userId: "u",
        publicUrl: "https://x",
      }),
    ).rejects.toThrow(/without a URL/);
  });
});
