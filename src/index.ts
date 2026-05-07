import { makeDispatcherHook } from "./alerts/dispatcher.js";
import { InMemoryAlertSender } from "./alerts/sender.js";
import { makeStripe, StripeBillingClient } from "./billing/checkout.js";
import { startBot } from "./bot/index.js";
import { StubBillingClient, type BillingClient } from "./bot/stripe.js";
import { loadConfig, redactConfig } from "./config.js";
import { startCron } from "./cron.js";
import { getPool } from "./db/client.js";
import { countActiveWatches } from "./db/watches.js";
import type { DigestTelegramSender } from "./jobs/daily-digest.js";
import { InMemoryPlotStore } from "./jobs/plot-store.js";
import type { WeeklyCalibrationTelegramSender } from "./jobs/weekly-calibration.js";
import { logger, loggerErrorSink, loggerInfoSink, loggerWarnSink } from "./log.js";
import { setActiveWatchesProvider } from "./metrics.js";
import { startPoller } from "./poller/index.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const safe = redactConfig(config);
  logger.info({ config: safe }, "config loaded");

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

  setActiveWatchesProvider(() => countActiveWatches(dbClient));

  const telegramGetMe = async (): Promise<unknown> => {
    const res = await fetch(
      `https://api.telegram.org/bot${config.TG_BOT_TOKEN}/getMe`,
    );
    if (!res.ok) throw new Error(`telegram getMe HTTP ${res.status}`);
    return res.json();
  };
  const stripePing = async (): Promise<unknown> => stripe.balance.retrieve();

  const plotStore = new InMemoryPlotStore();

  startServer({
    stripeWebhook: {
      client: dbClient,
      stripe,
      webhookSecret: config.STRIPE_WEBHOOK_SECRET,
      prices: { pulsePriceId, pulseProPriceId },
      log: loggerInfoSink({ component: "stripe" }),
    },
    telegramGetMe,
    stripePing,
    plotStore,
  });

  if (process.env.NODE_ENV !== "test") {
    const dispatcherHook = makeDispatcherHook({
      client: dbClient,
      sender: new InMemoryAlertSender(),
      log: loggerInfoSink({ component: "alerts" }),
      onError: loggerErrorSink({ component: "alerts" }),
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
        log: loggerInfoSink({ component: "bot" }),
      },
      log: loggerInfoSink({ component: "bot" }),
    });

    const telegram: DigestTelegramSender = {
      async sendMessage(chatId, text): Promise<void> {
        await botHandle.bot.api.sendMessage(chatId, text);
      },
    };
    const weeklyCalibrationTelegram: WeeklyCalibrationTelegramSender = telegram;

    startCron({
      digest: {
        client: dbClient,
        telegram,
        publicUrl: config.PUBLIC_URL,
        log: loggerInfoSink({ component: "digest" }),
        onError: loggerErrorSink({ component: "digest" }),
      },
      weeklyCalibration: {
        client: dbClient,
        telegram: weeklyCalibrationTelegram,
        plotStore,
        publicUrl: config.PUBLIC_URL,
        log: loggerInfoSink({ component: "weekly-calibration" }),
        onError: loggerErrorSink({ component: "weekly-calibration" }),
      },
      log: loggerInfoSink({ component: "cron" }),
      onError: loggerWarnSink({ component: "cron" }),
    });
  }
  logger.info("hn-pulse ready");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ err }, `startup fatal: ${msg}`);
  process.exitCode = 1;
});
