import { makeDispatcherHook } from "./alerts/dispatcher.js";
import { InMemoryAlertSender } from "./alerts/sender.js";
import { loadConfig, redactConfig } from "./config.js";
import { getPool } from "./db/client.js";
import { startPoller } from "./poller/index.js";
import { startServer } from "./server.js";

function main(): void {
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
    // Real Telegram sender lands in p1-006; until then alerts dispatch into an
    // in-memory stub so the alerts row still gets delivered_at populated.
    const dispatcherHook = makeDispatcherHook({
      client,
      sender: new InMemoryAlertSender(),
      onError: (err, label) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[${label}] ${msg}\n`);
      },
    });
    startPoller({ client, onSnapshotInserted: dispatcherHook });
  }
  process.stdout.write("hn-pulse ready\n");
}

main();
