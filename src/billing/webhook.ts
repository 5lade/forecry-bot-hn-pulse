/**
 * Stripe webhook handler (POST /stripe/webhook).
 *
 * Spec.md §6 ("Stripe webhook"): listens for checkout.session.completed,
 * customer.subscription.updated, customer.subscription.deleted and updates
 * users.tier accordingly. Price IDs (PULSE_PRICE_ID, PULSE_PRO_PRICE_ID)
 * map to the "pulse" / "pulse-pro" tiers; subscription deletion drops the
 * user back to "canceled".
 *
 * Signature verification uses stripe.webhooks.constructEvent — forged
 * payloads are rejected with HTTP 400 before any DB write happens.
 */

import type Stripe from "stripe";
import type { Request, Response } from "express";
import type { BotQueryClient } from "../bot/db.js";
import type { UserTier } from "../db/watches.js";

export interface PriceTierMap {
  pulsePriceId: string;
  pulseProPriceId: string;
}

export interface WebhookHandlerDeps {
  client: BotQueryClient;
  /** Object exposing `webhooks.constructEvent` — typically a real Stripe instance. */
  stripe: Pick<Stripe, "webhooks">;
  webhookSecret: string;
  prices: PriceTierMap;
  log?: (msg: string) => void;
}

export interface WebhookResult {
  status: 200 | 400;
  body: { received?: boolean; error?: string };
}

/**
 * Map a Stripe price id to a UserTier. Unknown prices return null —
 * callers should treat that as "leave the user's tier alone".
 */
export function priceIdToTier(
  priceId: string | null | undefined,
  prices: PriceTierMap,
): UserTier | null {
  if (!priceId) return null;
  if (priceId === prices.pulsePriceId) return "pulse";
  if (priceId === prices.pulseProPriceId) return "pulse-pro";
  return null;
}

/**
 * Pull the first line-item price id off a Stripe.Subscription. Stripe
 * subscriptions can technically carry multiple items but our products only
 * sell one plan per subscription, so we read items.data[0].
 */
function priceIdFromSubscription(
  subscription: Stripe.Subscription,
): string | null {
  const item = subscription.items?.data?.[0];
  if (!item) return null;
  return item.price?.id ?? null;
}

async function setUserTierByCustomer(
  client: BotQueryClient,
  customerId: string,
  tier: UserTier,
): Promise<number> {
  const res = await client.query<{ id: string }>(
    `UPDATE users SET tier = $2 WHERE stripe_customer_id = $1 RETURNING id`,
    [customerId, tier],
  );
  return res.rows.length;
}

async function setUserCustomerAndTier(
  client: BotQueryClient,
  args: { userId: string; customerId: string; tier: UserTier },
): Promise<number> {
  const res = await client.query<{ id: string }>(
    `UPDATE users SET stripe_customer_id = $2, tier = $3 WHERE id = $1 RETURNING id`,
    [args.userId, args.customerId, args.tier],
  );
  return res.rows.length;
}

/**
 * Apply a verified Stripe event to the database.
 * Exported (separate from the express handler) so tests can drive it
 * directly with Stripe fixture objects without going through HTTP.
 */
export async function applyStripeEvent(
  event: Stripe.Event,
  deps: Omit<WebhookHandlerDeps, "stripe" | "webhookSecret">,
): Promise<void> {
  const log = deps.log ?? (() => {});

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id;
      const customerId =
        typeof session.customer === "string"
          ? session.customer
          : session.customer?.id ?? null;

      if (!userId) {
        log(`[stripe] checkout.session.completed missing client_reference_id`);
        return;
      }
      if (!customerId) {
        log(`[stripe] checkout.session.completed missing customer for user ${userId}`);
        return;
      }
      // Default new subscriptions to pulse; the subscription.updated event
      // that follows immediately will refine to pulse-pro if applicable.
      const tier: UserTier = "pulse";
      const updated = await setUserCustomerAndTier(deps.client, {
        userId,
        customerId,
        tier,
      });
      log(`[stripe] checkout.completed user=${userId} customer=${customerId} updated=${updated}`);
      return;
    }

    case "customer.subscription.updated":
    case "customer.subscription.created": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer.id;
      const priceId = priceIdFromSubscription(subscription);
      const mapped = priceIdToTier(priceId, deps.prices);
      // Stripe may report status="canceled" via subscription.updated when a
      // cancel-at-period-end takes effect; treat that exactly like a deletion.
      const tier: UserTier =
        subscription.status === "canceled" || subscription.status === "incomplete_expired"
          ? "canceled"
          : mapped ?? "pulse";
      const updated = await setUserTierByCustomer(deps.client, customerId, tier);
      log(
        `[stripe] subscription.updated customer=${customerId} status=${subscription.status} ` +
          `price=${priceId ?? "?"} -> tier=${tier} updated=${updated}`,
      );
      return;
    }

    case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer.id;
      const updated = await setUserTierByCustomer(deps.client, customerId, "canceled");
      log(`[stripe] subscription.deleted customer=${customerId} updated=${updated}`);
      return;
    }

    default:
      log(`[stripe] ignoring event type ${event.type}`);
      return;
  }
}

/**
 * Verify the Stripe-Signature header against the raw body and dispatch.
 * Returns the response that should be written back to Stripe.
 */
export async function handleStripeWebhook(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  deps: WebhookHandlerDeps,
): Promise<WebhookResult> {
  if (!signatureHeader) {
    return { status: 400, body: { error: "missing Stripe-Signature header" } };
  }
  let event: Stripe.Event;
  try {
    event = deps.stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      deps.webhookSecret,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log?.(`[stripe] signature verification failed: ${msg}`);
    return { status: 400, body: { error: "invalid signature" } };
  }

  try {
    await applyStripeEvent(event, deps);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.log?.(`[stripe] event ${event.type} apply failed: ${msg}`);
    // Returning 400 would make Stripe retry. We surface 200 to avoid
    // retry storms on a poison event; the error is logged for ops.
    return { status: 200, body: { received: true } };
  }

  return { status: 200, body: { received: true } };
}

/**
 * Express handler factory. The route MUST be mounted with
 * express.raw({ type: "application/json" }) so req.body stays a Buffer —
 * Stripe's signature check needs the exact bytes that were transmitted.
 */
export function makeStripeWebhookRoute(deps: WebhookHandlerDeps) {
  return async (req: Request, res: Response): Promise<void> => {
    const sig = req.header("stripe-signature");
    const raw = (req.body as Buffer | string | undefined) ?? Buffer.alloc(0);
    const result = await handleStripeWebhook(raw, sig, deps);
    res.status(result.status).json(result.body);
  };
}
