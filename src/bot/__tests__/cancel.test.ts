import { describe, expect, it } from "vitest";
import type {
  BillingClient,
  BillingPortalSession,
  CheckoutSession,
} from "../stripe.js";
import { makeBotKit, makeCommandUpdate, makeFakeDb } from "./test-helpers.js";

class FakeBilling implements BillingClient {
  portalCalls: Array<{ customerId: string }> = [];

  async createCheckoutSession(): Promise<CheckoutSession> {
    return { id: "cs_test", url: "https://stripe.example/checkout/x" };
  }

  async createBillingPortalSession(args: {
    customerId: string;
    publicUrl: string;
  }): Promise<BillingPortalSession> {
    this.portalCalls.push({ customerId: args.customerId });
    return { id: "bps_test", url: "https://stripe.example/portal/abc" };
  }
}

describe("/cancel", () => {
  it("returns billing portal URL for paying users", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u",
          telegram_user_id: 1,
          tier: "pulse",
          threshold_pct: 60,
          digest_opt_in: true,
          stripe_customer_id: "cus_PAID",
        },
      ],
    });
    const billing = new FakeBilling();
    const kit = await makeBotKit({ client: db.client, billing });

    await kit.send(makeCommandUpdate({ command: "cancel", fromId: 1 }));

    expect(billing.portalCalls).toEqual([{ customerId: "cus_PAID" }]);
    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain(
      "https://stripe.example/portal/abc",
    );
  });

  it("tells free users they have nothing to cancel", async () => {
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

    await kit.send(makeCommandUpdate({ command: "cancel", fromId: 1 }));

    expect(billing.portalCalls).toHaveLength(0);
    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("nothing to cancel");
  });
});
