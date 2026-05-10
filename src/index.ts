import { makeDispatcherHook } from "./alerts/dispatcher.js";
import { InMemoryAlertSender } from "./alerts/sender.js";
import { makeStripe, StripeBillingClient } from "./billing/checkout.js";
import { startBot } from "./bot/index.js";
import { StubBillingClient, type BillingClient } from "./bot/stripe.js";
import { isSoakEnv, loadConfig, redactConfig } from "./config.js";
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

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length === 0 ||
    trimmed.includes("placeholder") ||
    (trimmed.startsWith("<") && trimmed.endsWith(">"))
  );
}

function disabledDependency(label: string): () => Promise<never> {
  return async () => {
    throw new Error(`${label} disabled in soak/dry-run mode`);
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const soak = isSoakEnv();
  const safe = redactConfig(config);
  logger.info({ config: safe }, "config loaded");

  const pulsePriceId = process.env.PULSE_PRICE_ID ?? "";
  const pulseProPriceId = process.env.PULSE_PRO_PRICE_ID ?? "";
  const stripeEnabled =
    soak ? config.STRIPE_SECRET_KEY.startsWith("sk_test_") : !isPlaceholder(config.STRIPE_SECRET_KEY);
  const stripeWebhookEnabled =
    stripeEnabled &&
    !isPlaceholder(config.STRIPE_WEBHOOK_SECRET) &&
    config.STRIPE_WEBHOOK_SECRET.startsWith("whsec_");
  const telegramEnabled = soak
    ? !isPlaceholder(config.TG_BOT_TOKEN)
    : !isPlaceholder(config.TG_BOT_TOKEN);
  const stripe = stripeEnabled ? makeStripe(config.STRIPE_SECRET_KEY) : null;

  if (soak) {
    logger.warn(
      {
        integrations: {
          stripe: stripeEnabled ? "enabled" : "disabled",
          stripeWebhook: stripeWebhookEnabled ? "enabled" : "disabled",
          telegram: telegramEnabled ? "enabled" : "disabled",
        },
      },
      "soak/dry-run mode active; disabled integrations are reported as degraded",
    );
  }

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

  const telegramGetMe = telegramEnabled
    ? async (): Promise<unknown> => {
        const res = await fetch(
          `https://api.telegram.org/bot${config.TG_BOT_TOKEN}/getMe`,
        );
        if (!res.ok) throw new Error(`telegram getMe HTTP ${res.status}`);
        return res.json();
      }
    : disabledDependency("telegram");
  const stripePing = stripe
    ? async (): Promise<unknown> => stripe.balance.retrieve()
    : disabledDependency("stripe");

  const plotStore = new InMemoryPlotStore();

  startServer({
    ...(stripe && stripeWebhookEnabled
      ? {
          stripeWebhook: {
            client: dbClient,
            stripe,
            webhookSecret: config.STRIPE_WEBHOOK_SECRET,
            prices: { pulsePriceId, pulseProPriceId },
            log: loggerInfoSink({ component: "stripe" }),
          },
        }
      : {}),
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
    const billing: BillingClient = stripe && pulsePriceId
      ? new StripeBillingClient({ stripe, pulsePriceId })
      : new StubBillingClient(config.PUBLIC_URL);

    const telegram: DigestTelegramSender = telegramEnabled
      ? await (async () => {
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
          return {
            async sendMessage(chatId, text): Promise<void> {
              await botHandle.bot.api.sendMessage(chatId, text);
            },
          };
        })()
      : {
          async sendMessage(): Promise<void> {
            logger.warn(
              "telegram delivery skipped because Telegram is disabled in soak/dry-run mode",
            );
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
