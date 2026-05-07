import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import type { HealthQueryClient } from "./health.js";
import { createApp } from "./server.js";

function client(handler: (text: string) => Promise<unknown>): HealthQueryClient {
  return {
    async query<T extends Record<string, unknown>>(
      text: string,
    ): Promise<{ rows: T[] }> {
      const rows = (await handler(text)) as T[];
      return { rows };
    },
  };
}

const okHandler = async (text: string) => {
  if (text.startsWith("SELECT 1")) return [];
  return [{ first_seen_at: new Date() }];
};

const stalledHandler = async (text: string) => {
  if (text.startsWith("SELECT 1")) return [];
  return [{ first_seen_at: new Date(Date.now() - 60 * 60 * 1000) }];
};

const dbDownHandler = async () => {
  throw new Error("ECONNREFUSED");
};

async function withServer<T>(
  c: HealthQueryClient,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const app = createApp({ client: c });
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    return await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /health", () => {
  it("returns 200 with ok=true when db and poller are healthy", async () => {
    await withServer(client(okHandler), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        checks: { db: { ok: boolean }; poller: { ok: boolean } };
      };
      expect(body.ok).toBe(true);
      expect(body.checks.db.ok).toBe(true);
      expect(body.checks.poller.ok).toBe(true);
    });
  });

  it("returns 503 with JSON body when DB is unreachable", async () => {
    await withServer(client(dbDownHandler), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        ok: boolean;
        checks: {
          db: { ok: boolean; detail?: string };
          poller: { ok: boolean };
        };
      };
      expect(body.ok).toBe(false);
      expect(body.checks.db.ok).toBe(false);
      expect(body.checks.db.detail).toBeDefined();
    });
  });

  it("returns 503 when poller is stalled", async () => {
    await withServer(client(stalledHandler), async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        ok: boolean;
        checks: { poller: { ok: boolean; detail?: string } };
      };
      expect(body.ok).toBe(false);
      expect(body.checks.poller.ok).toBe(false);
      expect(body.checks.poller.detail).toMatch(/poller stalled/);
    });
  });
});
