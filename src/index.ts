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
    startPoller({
      client: {
        async query<T extends Record<string, unknown>>(
          text: string,
          params?: ReadonlyArray<unknown>,
        ): Promise<{ rows: T[] }> {
          const r = await getPool().query(
            text,
            params as unknown[] | undefined,
          );
          return { rows: r.rows as T[] };
        },
      },
    });
  }
  process.stdout.write("hn-pulse ready\n");
}

main();
