import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type {
  HealthQueryClient,
  StripePing,
  TelegramGetMe,
} from "./health.js";
import { decodePngHeader, encodePng, PNG_SIGNATURE } from "./jobs/png.js";
import { InMemoryPlotStore } from "./jobs/plot-store.js";
import { createApp, type CreateAppOptions } from "./server.js";

function dbClient(handler: (text: string) => Promise<unknown>): HealthQueryClient {
  return {
    async query<T extends Record<string, unknown>>(
      text: string,
    ): Promise<{ rows: T[] }> {
      const rows = (await handler(text)) as T[];
      return { rows };
    },
  };
}

const okDb: HealthQueryClient = dbClient(async () => []);
const downDb: HealthQueryClient = dbClient(async () => {
  throw new Error("ECONNREFUSED");
});
const okGetMe: TelegramGetMe = async () => ({ ok: true });
const downGetMe: TelegramGetMe = async () => {
  throw new Error("telegram unauthorized");
};
const okPing: StripePing = async () => ({ available: [] });
const downPing: StripePing = async () => {
  throw new Error("stripe down");
};

function fixedNow(): Date {
  return new Date("2025-01-01T00:00:00Z");
}
function recentPoll(): Date {
  return new Date("2024-12-31T23:59:30Z");
}
function stalePoll(): Date {
  return new Date("2024-12-31T22:00:00Z");
}

const okOpts: CreateAppOptions = {
  client: okDb,
  telegramGetMe: okGetMe,
  stripePing: okPing,
  getLastBatchAt: recentPoll,
  now: fixedNow,
};

async function withServer<T>(
  opts: CreateAppOptions,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const app = createApp(opts);
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    return await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("GET /health (cheap liveness)", () => {
  it("returns 200 with status ok, uptime, and version — no I/O", async () => {
    await withServer(
      { startedAt: Date.now() - 1500, version: "9.9.9" },
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          status: string;
          uptime: number;
          version: string;
        };
        expect(body.status).toBe("ok");
        expect(body.version).toBe("9.9.9");
        expect(body.uptime).toBeGreaterThanOrEqual(1.4);
      },
    );
  });

  it("p99 latency under 50ms across 200 calls", async () => {
    await withServer({}, async (port) => {
      const url = `http://127.0.0.1:${port}/health`;
      // Warm up so the JIT and HTTP client connection pool stabilize.
      for (let i = 0; i < 10; i += 1) {
        const res = await fetch(url);
        await res.text();
      }
      const samples: number[] = [];
      for (let i = 0; i < 200; i += 1) {
        const start = performance.now();
        const res = await fetch(url);
        await res.text();
        samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      const p99 = samples[Math.ceil(samples.length * 0.99) - 1];
      expect(p99).toBeLessThan(50);
    });
  });
});

describe("GET /healthz (deep readiness)", () => {
  it("returns 200 + ok=true when every dependency is healthy", async () => {
    await withServer(okOpts, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        checks: Record<string, { status: string }>;
      };
      expect(body.ok).toBe(true);
      expect(body.checks.db.status).toBe("ok");
      expect(body.checks.poller.status).toBe("ok");
      expect(body.checks.telegram.status).toBe("ok");
      expect(body.checks.stripe.status).toBe("ok");
    });
  });

  it("returns 503 + identifies db when SELECT 1 fails", async () => {
    await withServer({ ...okOpts, client: downDb }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        ok: boolean;
        checks: Record<string, { status: string; reason?: string }>;
      };
      expect(body.ok).toBe(false);
      expect(body.checks.db.status).toBe("down");
      expect(body.checks.db.reason).toBeTruthy();
      expect(body.checks.poller.status).toBe("ok");
      expect(body.checks.telegram.status).toBe("ok");
      expect(body.checks.stripe.status).toBe("ok");
    });
  });

  it("returns 503 + identifies poller when last poll is stale", async () => {
    await withServer(
      { ...okOpts, getLastBatchAt: stalePoll },
      async (port) => {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        expect(res.status).toBe(503);
        const body = (await res.json()) as {
          ok: boolean;
          checks: Record<string, { status: string; reason?: string }>;
        };
        expect(body.ok).toBe(false);
        expect(body.checks.poller.status).toBe("down");
        expect(body.checks.poller.reason).toMatch(/poll lag/);
      },
    );
  });

  it("returns 503 + identifies telegram when getMe fails", async () => {
    await withServer({ ...okOpts, telegramGetMe: downGetMe }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        ok: boolean;
        checks: Record<string, { status: string; reason?: string }>;
      };
      expect(body.ok).toBe(false);
      expect(body.checks.telegram.status).toBe("down");
      expect(body.checks.telegram.reason).toMatch(/unauthorized/);
    });
  });

  it("returns 503 + identifies stripe when ping fails", async () => {
    await withServer({ ...okOpts, stripePing: downPing }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        ok: boolean;
        checks: Record<string, { status: string; reason?: string }>;
      };
      expect(body.ok).toBe(false);
      expect(body.checks.stripe.status).toBe("down");
      expect(body.checks.stripe.reason).toMatch(/stripe down/);
    });
  });
});

describe("GET /plots/:key.png", () => {
  it("serves a stored PNG that decodes correctly", async () => {
    const plotStore = new InMemoryPlotStore();
    const png = encodePng(
      4,
      2,
      new Uint8Array([
        0xff, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0x00, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0xff, 0x00, 0xff, 0xff, 0xff,
        0xff, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0xff,
      ]),
    );
    await plotStore.put("weekly-calibration/2026-04-27/u-1", png);

    await withServer({ ...okOpts, plotStore }, async (port) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/plots/weekly-calibration/2026-04-27/u-1.png`,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      const header = decodePngHeader(body);
      expect(header.width).toBe(4);
      expect(header.height).toBe(2);
    });
  });

  it("returns 404 when the key is unknown", async () => {
    const plotStore = new InMemoryPlotStore();
    await withServer({ ...okOpts, plotStore }, async (port) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/plots/missing-key.png`,
      );
      expect(res.status).toBe(404);
    });
  });

  it("does not mount the route when no plotStore is provided", async () => {
    await withServer({ ...okOpts }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/plots/anything.png`);
      expect(res.status).toBe(404);
    });
  });
});
