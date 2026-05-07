import { makeDispatcherHook } from "./alerts/dispatcher.js";
import { InMemoryAlertSender } from "./alerts/sender.js";
import { startBot } from "./bot/index.js";
import { StubBillingClient } from "./bot/stripe.js";
import { loadConfig, redactConfig } from "./config.js";
import { getPool } from "./db/client.js";
import { startPoller } from "./poller/index.js";
import { startServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const safe = redactConfig(config);
  process.stdout.write(`config loaded: ${JSON.stringify(safe)}\n`);
  startServer();
  if (process.env.NODE_ENV !== "test") {
    const client = {
      async query<T extends Record<string, unknown>>(
        text: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<{ rows: T[] }> {
        const r = await getPool().query(text, params as unknown[] | undefined);
        return { rows: r.rows as T[] };
      },
    };
    const dispatcherHook = makeDispatcherHook({
      client,
      sender: new InMemoryAlertSender(),
      onError: (err, label) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${label}] ${msg}\n`);
      },
    });
    startPoller({ client, onSnapshotInserted: dispatcherHook });

    // p1-007 will replace StubBillingClient with a real Stripe-backed
    // implementation. Until then the bot hands users a placeholder URL.
    const billing = new StubBillingClient(config.PUBLIC_URL);

    await startBot({
      token: config.TG_BOT_TOKEN,
      deps: {
        client,
        billing,
        publicUrl: config.PUBLIC_URL,
        log: (msg) => process.stdout.write(`${msg}\n`),
      },
      log: (msg) => process.stdout.write(`${msg}\n`),
    });
  }
  process.stdout.write("hn-pulse ready\n");
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[startup] fatal: ${msg}\n`);
  process.exitCode = 1;
});
