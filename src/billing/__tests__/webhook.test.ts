import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import type { BotQueryClient } from "../../bot/db.js";
import {
  applyStripeEvent,
  handleStripeWebhook,
  priceIdToTier,
} from "../webhook.js";

const PULSE_PRICE_ID = "price_pulse_test";
const PULSE_PRO_PRICE_ID = "price_pulse_pro_test";
const WEBHOOK_SECRET = "whsec_test_secret_for_signature_check";

const PRICES = {
  pulsePriceId: PULSE_PRICE_ID,
  pulseProPriceId: PULSE_PRO_PRICE_ID,
};

interface FakeUser {
  id: string;
  tier: string;
  stripe_customer_id: string | null;
}

function makeFakeClient(seed: FakeUser[]): {
  client: BotQueryClient;
  users: FakeUser[];
} {
  const users = seed.map((u) => ({ ...u }));
  const client: BotQueryClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      const sql = text.trim();
      // UPDATE ... WHERE id = $1 (after checkout, sets customer + tier)
      if (/^UPDATE users SET stripe_customer_id\s*=\s*\$2,\s*tier\s*=\s*\$3 WHERE id/i.test(sql)) {
        const userId = String(params![0]);
        const customerId = String(params![1]);
        const tier = String(params![2]);
        const u = users.find((x) => x.id === userId);
        if (!u) return { rows: [] };
        u.stripe_customer_id = customerId;
        u.tier = tier;
        return { rows: [{ id: u.id } as unknown as T] };
      }
      // UPDATE ... WHERE stripe_customer_id = $1 (subscription updates)
      if (/^UPDATE users SET tier\s*=\s*\$2 WHERE stripe_customer_id/i.test(sql)) {
        const customerId = String(params![0]);
        const tier = String(params![1]);
        const u = users.find((x) => x.stripe_customer_id === customerId);
        if (!u) return { rows: [] };
        u.tier = tier;
        return { rows: [{ id: u.id } as unknown as T] };
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 120)}`);
    },
  };
  return { client, users };
}

/** Build a signed request body+header pair for a given event payload. */
function signEvent(stripe: Stripe, event: Record<string, unknown>): {
  body: string;
  signature: string;
} {
  const body = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: WEBHOOK_SECRET,
  });
  return { body, signature };
}

const stripe = new Stripe("sk_test_dummy", { apiVersion: "2025-02-24.acacia" });

describe("priceIdToTier", () => {
  it("maps the pulse price to the pulse tier", () => {
    expect(priceIdToTier(PULSE_PRICE_ID, PRICES)).toBe("pulse");
  });
  it("maps the pro price to the pulse-pro tier", () => {
    expect(priceIdToTier(PULSE_PRO_PRICE_ID, PRICES)).toBe("pulse-pro");
  });
  it("returns null for unknown prices", () => {
    expect(priceIdToTier("price_other", PRICES)).toBeNull();
    expect(priceIdToTier(null, PRICES)).toBeNull();
    expect(priceIdToTier(undefined, PRICES)).toBeNull();
  });
});

describe("handleStripeWebhook signature verification", () => {
  it("rejects forged events with 400", async () => {
    const { client } = makeFakeClient([]);
    const fakeEvent = {
      id: "evt_forged",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_forged" } },
    };
    const result = await handleStripeWebhook(
      JSON.stringify(fakeEvent),
      "t=12345,v1=deadbeef", // hand-rolled bogus header
      { client, stripe, webhookSecret: WEBHOOK_SECRET, prices: PRICES },
    );
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: expect.any(String) });
  });

  it("rejects requests with no Stripe-Signature header", async () => {
    const { client } = makeFakeClient([]);
    const result = await handleStripeWebhook(
      JSON.stringify({ id: "evt_x", type: "ping" }),
      undefined,
      { client, stripe, webhookSecret: WEBHOOK_SECRET, prices: PRICES },
    );
    expect(result.status).toBe(400);
  });

  it("accepts events whose signature was generated with the same secret", async () => {
    const { client, users } = makeFakeClient([
      { id: "u1", tier: "free", stripe_customer_id: null },
    ]);
    const event = {
      id: "evt_ok",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_ok",
          object: "checkout.session",
          client_reference_id: "u1",
          customer: "cus_ok",
        },
      },
    };
    const { body, signature } = signEvent(stripe, event);

    const result = await handleStripeWebhook(body, signature, {
      client,
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      prices: PRICES,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ received: true });
    expect(users[0]).toMatchObject({
      tier: "pulse",
      stripe_customer_id: "cus_ok",
    });
  });
});

describe("applyStripeEvent — subscription lifecycle free → pulse → canceled", () => {
  it("checkout.session.completed transitions free → pulse and records the customer id", async () => {
    const { client, users } = makeFakeClient([
      { id: "u1", tier: "free", stripe_customer_id: null },
    ]);
    const event = {
      id: "evt_1",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_1",
          client_reference_id: "u1",
          customer: "cus_123",
        },
      },
    } as unknown as Stripe.Event;

    await applyStripeEvent(event, { client, prices: PRICES });

    expect(users[0]).toMatchObject({
      tier: "pulse",
      stripe_customer_id: "cus_123",
    });
  });

  it("customer.subscription.updated to pulse-pro upgrades the tier", async () => {
    const { client, users } = makeFakeClient([
      { id: "u1", tier: "pulse", stripe_customer_id: "cus_123" },
    ]);
    const event = {
      id: "evt_2",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_123",
          status: "active",
          items: {
            data: [{ id: "si_1", price: { id: PULSE_PRO_PRICE_ID } }],
          },
        },
      },
    } as unknown as Stripe.Event;

    await applyStripeEvent(event, { client, prices: PRICES });

    expect(users[0]?.tier).toBe("pulse-pro");
  });

  it("customer.subscription.deleted transitions tier → canceled", async () => {
    const { client, users } = makeFakeClient([
      { id: "u1", tier: "pulse", stripe_customer_id: "cus_123" },
    ]);
    const event = {
      id: "evt_3",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_1",
          customer: "cus_123",
          status: "canceled",
          items: {
            data: [{ id: "si_1", price: { id: PULSE_PRICE_ID } }],
          },
        },
      },
    } as unknown as Stripe.Event;

    await applyStripeEvent(event, { client, prices: PRICES });

    expect(users[0]?.tier).toBe("canceled");
  });

  it("full lifecycle: free → pulse → pulse-pro → canceled", async () => {
    const { client, users } = makeFakeClient([
      { id: "u1", tier: "free", stripe_customer_id: null },
    ]);

    await applyStripeEvent(
      {
        id: "e1",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_1",
            client_reference_id: "u1",
            customer: "cus_lifecycle",
          },
        },
      } as unknown as Stripe.Event,
      { client, prices: PRICES },
    );
    expect(users[0]?.tier).toBe("pulse");

    await applyStripeEvent(
      {
        id: "e2",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_1",
            customer: "cus_lifecycle",
            status: "active",
            items: { data: [{ id: "si", price: { id: PULSE_PRO_PRICE_ID } }] },
          },
        },
      } as unknown as Stripe.Event,
      { client, prices: PRICES },
    );
    expect(users[0]?.tier).toBe("pulse-pro");

    await applyStripeEvent(
      {
        id: "e3",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_1",
            customer: "cus_lifecycle",
            status: "canceled",
            items: { data: [{ id: "si", price: { id: PULSE_PRO_PRICE_ID } }] },
          },
        },
      } as unknown as Stripe.Event,
      { client, prices: PRICES },
    );
    expect(users[0]?.tier).toBe("canceled");
  });

  it("ignores unrelated event types without throwing", async () => {
    const { client, users } = makeFakeClient([
      { id: "u1", tier: "pulse", stripe_customer_id: "cus_x" },
    ]);
    await applyStripeEvent(
      {
        id: "evt_ignored",
        type: "customer.created",
        data: { object: { id: "cus_x" } },
      } as unknown as Stripe.Event,
      { client, prices: PRICES },
    );
    expect(users[0]?.tier).toBe("pulse");
  });
});
