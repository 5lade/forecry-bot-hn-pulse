import { makeDispatcherHook } from "./alerts/dispatcher.js";
import { InMemoryAlertSender } from "./alerts/sender.js";
import { makeStripe, StripeBillingClient } from "./billing/checkout.js";
import { startBot } from "./bot/index.js";
import { StubBillingClient, type BillingClient } from "./bot/stripe.js";
import { loadConfig, redactConfig } from "./config.js";
import { startCron } from "./cron.js";
import { getPool } from "./db/client.js";
import type { DigestTelegramSender } from "./jobs/daily-digest.js";
import { startPoller } from "./poller/index.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const safe = redactConfig(config);
  process.stdout.write(`config loaded: ${JSON.stringify(safe)}\n`);

  const pulsePriceId = process.env.PULSE_PRICE_ID ?? "";
  const pulseProPriceId = process.env.PULSE_PRO_PRICE_ID ?? "";
  const stripe = makeStripe(config.STRIPE_SECRET_KEY);

  const dbClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      const r = await getPool().query(text, params as unknown[] | undefined);
      return { rows: r.rows as T[] };
    },
  };

  startServer({
    stripeWebhook: {
      client: dbClient,
      stripe,
      webhookSecret: config.STRIPE_WEBHOOK_SECRET,
      prices: { pulsePriceId, pulseProPriceId },
      log: (msg) => process.stdout.write(`${msg}\n`),
    },
  });

  if (process.env.NODE_ENV !== "test") {
    const dispatcherHook = makeDispatcherHook({
      client: dbClient,
      sender: new InMemoryAlertSender(),
      onError: (err, label) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${label}] ${msg}\n`);
      },
    });
    startPoller({ client: dbClient, onSnapshotInserted: dispatcherHook });

    // Use the real Stripe-backed billing client when a price id is wired,
    // otherwise fall back to the stub so dev/test envs without Stripe work.
    const billing: BillingClient = pulsePriceId
      ? new StripeBillingClient({ stripe, pulsePriceId })
      : new StubBillingClient(config.PUBLIC_URL);

    const botHandle = await startBot({
      token: config.TG_BOT_TOKEN,
      deps: {
        client: dbClient,
        billing,
        publicUrl: config.PUBLIC_URL,
        log: (msg) => process.stdout.write(`${msg}\n`),
      },
      log: (msg) => process.stdout.write(`${msg}\n`),
    });

    const telegram: DigestTelegramSender = {
      async sendMessage(chatId, text): Promise<void> {
        await botHandle.bot.api.sendMessage(chatId, text);
      },
    };

    startCron({
      digest: {
        client: dbClient,
        telegram,
        publicUrl: config.PUBLIC_URL,
        log: (msg) => process.stdout.write(`${msg}\n`),
        onError: (err, label) => {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`[${label}] ${msg}\n`);
        },
      },
      log: (msg) => process.stdout.write(`${msg}\n`),
      onError: (err, label) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[cron:${label}] ${msg}\n`);
      },
    });
  }
  process.stdout.write("hn-pulse ready\n");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[startup] fatal: ${msg}\n`);
  process.exitCode = 1;
});
