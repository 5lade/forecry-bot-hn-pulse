import express, { type Express } from "express";
import type { Server } from "node:http";
import { getPool } from "./db/client.js";
import { runHealthChecks, type HealthQueryClient } from "./health.js";

export interface CreateAppOptions {
  client?: HealthQueryClient;
  now?: () => Date;
}

export function createApp(opts: CreateAppOptions = {}): Express {
  const app = express();
  const client: HealthQueryClient =
    opts.client ?? {
      async query<T extends Record<string, unknown>>(
        text: string,
        params?: ReadonlyArray<unknown>,
      ): Promise<{ rows: T[] }> {
        const result = await getPool().query(
          text,
          params as unknown[] | undefined,
        );
        return { rows: result.rows as T[] };
      },
    };
  const now = opts.now ?? (() => new Date());

  app.get("/health", async (_req, res) => {
    const report = await runHealthChecks(client, now);
    res.status(report.ok ? 200 : 503).json(report);
  });

  return app;
}

export interface StartServerOptions extends CreateAppOptions {
  port?: number;
}

export function startServer(opts: StartServerOptions = {}): Server {
  const port = opts.port ?? Number(process.env.PORT ?? 8080);
  const app = createApp(opts);
  return app.listen(port, () => {
    process.stdout.write(`[server] listening on :${port}\n`);
  });
}
