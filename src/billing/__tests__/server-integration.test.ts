import type { AddressInfo } from "node:net";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import type { BotQueryClient } from "../../bot/db.js";
import type { HealthQueryClient } from "../../health.js";
import { createApp } from "../../server.js";

const WEBHOOK_SECRET = "whsec_integration_test_secret";

describe("POST /stripe/webhook (integration via express)", () => {
  it("returns 200 for a properly signed event and updates the user", async () => {
    const updates: Array<{ text: string; params: ReadonlyArray<unknown> }> = [];
    const billingClient: BotQueryClient = {
      async query<T extends Record<string, unknown>>(
        text: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<{ rows: T[] }> {
        updates.push({ text, params: params ?? [] });
        return { rows: [{ id: "u1" } as unknown as T] };
      },
    };
    const healthClient: HealthQueryClient = {
      async query<T extends Record<string, unknown>>(): Promise<{ rows: T[] }> {
        return { rows: [] };
      },
    };
    const stripe = new Stripe("sk_test_dummy", {
      apiVersion: "2025-02-24.acacia",
    });

    const app = createApp({
      client: healthClient,
      stripeWebhook: {
        client: billingClient,
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        prices: {
          pulsePriceId: "price_pulse",
          pulseProPriceId: "price_pulse_pro",
        },
      },
    });

    const event = {
      id: "evt_int_1",
      object: "event",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_int_1",
          object: "checkout.session",
          client_reference_id: "u1",
          customer: "cus_int_1",
        },
      },
    };
    const body = JSON.stringify(event);
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: WEBHOOK_SECRET,
    });

    const server = app.listen(0);
    try {
      await new Promise<void>((r) => server.once("listening", r));
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/stripe/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature,
        },
        body,
      });
      expect(res.status).toBe(200);
      expect(updates).toHaveLength(1);
      // Verifies the SQL hits stripe_customer_id + tier with the customer id.
      expect(updates[0]!.params).toEqual(["u1", "cus_int_1", "pulse"]);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("returns 400 for a request with an invalid signature", async () => {
    const billingClient: BotQueryClient = {
      async query<T extends Record<string, unknown>>(): Promise<{ rows: T[] }> {
        throw new Error("should not be called for forged events");
      },
    };
    const stripe = new Stripe("sk_test_dummy", {
      apiVersion: "2025-02-24.acacia",
    });
    const app = createApp({
      stripeWebhook: {
        client: billingClient,
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        prices: { pulsePriceId: "p", pulseProPriceId: "pp" },
      },
    });

    const server = app.listen(0);
    try {
      await new Promise<void>((r) => server.once("listening", r));
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/stripe/webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "t=1,v1=deadbeef",
        },
        body: JSON.stringify({ id: "evt_forged", type: "checkout.session.completed" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
