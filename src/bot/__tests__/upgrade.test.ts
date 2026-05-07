import { describe, expect, it } from "vitest";
import type {
  BillingClient,
  BillingPortalSession,
  CheckoutSession,
} from "../stripe.js";
import { makeBotKit, makeCommandUpdate, makeFakeDb } from "./test-helpers.js";

class FakeBilling implements BillingClient {
  checkoutCalls: Array<{ telegramUserId: number; userId: string }> = [];
  portalCalls: Array<{ customerId: string }> = [];
  shouldFail = false;

  async createCheckoutSession(args: {
    telegramUserId: number;
    userId: string;
    publicUrl: string;
  }): Promise<CheckoutSession> {
    this.checkoutCalls.push({
      telegramUserId: args.telegramUserId,
      userId: args.userId,
    });
    if (this.shouldFail) throw new Error("stripe down");
    return { id: "cs_test", url: "https://stripe.example/checkout/abc" };
  }

  async createBillingPortalSession(args: {
    customerId: string;
    publicUrl: string;
  }): Promise<BillingPortalSession> {
    this.portalCalls.push({ customerId: args.customerId });
    return { id: "bps_test", url: "https://stripe.example/portal/abc" };
  }
}

describe("/upgrade", () => {
  it("creates a checkout session and replies with the URL for free users", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u",
          telegram_user_id: 1,
          tier: "free",
          threshold_pct: 60,
          digest_opt_in: true,
          stripe_customer_id: null,
        },
      ],
    });
    const billing = new FakeBilling();
    const kit = await makeBotKit({ client: db.client, billing });

    await kit.send(makeCommandUpdate({ command: "upgrade", fromId: 1 }));

    expect(billing.checkoutCalls).toEqual([{ telegramUserId: 1, userId: "u" }]);
    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain(
      "https://stripe.example/checkout/abc",
    );
  });

  it("tells already-paid users to use /cancel instead", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u",
          telegram_user_id: 1,
          tier: "pulse",
          threshold_pct: 60,
          digest_opt_in: true,
          stripe_customer_id: "cus_X",
        },
      ],
    });
    const billing = new FakeBilling();
    const kit = await makeBotKit({ client: db.client, billing });

    await kit.send(makeCommandUpdate({ command: "upgrade", fromId: 1 }));

    expect(billing.checkoutCalls).toHaveLength(0);
    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("already on pulse");
  });

  it("falls back to a friendly error when Stripe fails", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u",
          telegram_user_id: 1,
          tier: "free",
          threshold_pct: 60,
          digest_opt_in: true,
          stripe_customer_id: null,
        },
      ],
    });
    const billing = new FakeBilling();
    billing.shouldFail = true;
    const kit = await makeBotKit({ client: db.client, billing });

    await kit.send(makeCommandUpdate({ command: "upgrade", fromId: 1 }));

    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain(
      "Could not create a checkout session",
    );
  });
});
