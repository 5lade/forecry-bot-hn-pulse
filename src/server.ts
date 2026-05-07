import express, { type Express } from "express";
import type { Server } from "node:http";
import {
  makeStripeWebhookRoute,
  type WebhookHandlerDeps,
} from "./billing/webhook.js";
import { getPool } from "./db/client.js";
import {
  runHealthChecks,
  type HealthQueryClient,
  type LastBatchAtGetter,
} from "./health.js";
import { childLogger } from "./log.js";
import { renderMetrics } from "./metrics.js";
import { getLastBatchAt as defaultLastBatchAt } from "./poller/index.js";

export interface CreateAppOptions {
  client?: HealthQueryClient;
  now?: () => Date;
  getLastBatchAt?: LastBatchAtGetter;
  /** When provided, mounts POST /stripe/webhook with raw-body parsing. */
  stripeWebhook?: WebhookHandlerDeps;
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
  const getLastBatchAt = opts.getLastBatchAt ?? defaultLastBatchAt;

  // Stripe needs the exact raw body for signature verification; mount
  // express.raw on this route only and *before* any global JSON parser.
  if (opts.stripeWebhook) {
    app.post(
      "/stripe/webhook",
      express.raw({ type: "application/json" }),
      makeStripeWebhookRoute(opts.stripeWebhook),
    );
  }

  app.get("/health", async (_req, res) => {
    const report = await runHealthChecks(client, now, getLastBatchAt);
    res.status(report.ok ? 200 : 503).json(report);
  });

  app.get("/metrics", async (_req, res) => {
    const { contentType, body } = await renderMetrics();
    res.set("Content-Type", contentType);
    res.send(body);
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
    childLogger({ component: "server" }).info({ port }, `listening on :${port}`);
  });
}

export { makeStripeWebhookRoute } from "./billing/webhook.js";
