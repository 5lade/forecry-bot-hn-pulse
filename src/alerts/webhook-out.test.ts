import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ItemsQueryClient } from "../db/items.js";
import { HttpError } from "../util/retry.js";
import type { AlertEnvelope } from "./sender.js";
import {
  signWebhookBody,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WebhookAlertSender,
  type WebhookEndpoint,
} from "./webhook-out.js";

interface QueryCall {
  text: string;
  params?: ReadonlyArray<unknown>;
}

interface DeadletterRow {
  id: string;
  alert_payload: string;
  error_message: string;
  attempts: number;
  created_at: Date;
}

interface FakeDb {
  client: ItemsQueryClient;
  calls: QueryCall[];
  deadletters: DeadletterRow[];
}

function makeDb(): FakeDb {
  const calls: QueryCall[] = [];
  const deadletters: DeadletterRow[] = [];
  const client: ItemsQueryClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      calls.push({ text, params });
      if (/^INSERT INTO alerts_deadletter/i.test(text.trim())) {
        deadletters.push({
          id: String(params?.[0]),
          alert_payload: String(params?.[1]),
          error_message: String(params?.[2]),
          attempts: Number(params?.[3]),
          created_at: params?.[4] as Date,
        });
      }
      return { rows: [] as T[] };
    },
  };
  return { client, calls, deadletters };
}

function envelope(overrides: Partial<AlertEnvelope> = {}): AlertEnvelope {
  return {
    alert_id: "alert-1",
    user_id: "u-1",
    item_id: 42,
    alert_type: "threshold",
    payload: {
      watch_type: "domain",
      watch_value: "example.com",
      p_front_page_6h: 0.9,
      delta_p_5min: 0.05,
      threshold_pct: 80,
    } as unknown as AlertEnvelope["payload"],
    ...overrides,
  };
}

interface FakeFetchCall {
  url: string;
  init: RequestInit;
}

function makeFakeFetch(
  responses: Array<{ status: number } | Error>,
): { fetch: typeof fetch; calls: FakeFetchCall[] } {
  const calls: FakeFetchCall[] = [];
  let i = 0;
  const fakeFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init: init ?? {} });
    const next = responses[i] ?? responses[responses.length - 1];
    i += 1;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next?.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

describe("signWebhookBody / verifyWebhookSignature", () => {
  it("produces a sha256= prefixed hex HMAC verifiable against the same secret", () => {
    const body = JSON.stringify({ alert_id: "x", item_id: 1 });
    const secret = "shhh-very-secret";
    const sig = signWebhookBody(body, secret);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Independent re-derivation matches our helper byte-for-byte.
    const expected =
      "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(sig).toBe(expected);
    expect(verifyWebhookSignature(body, secret, sig)).toBe(true);
  });

  it("rejects when the secret differs", () => {
    const body = "{}";
    const sig = signWebhookBody(body, "secret-A");
    expect(verifyWebhookSignature(body, "secret-B", sig)).toBe(false);
  });

  it("rejects when the body has been tampered with", () => {
    const sig = signWebhookBody("{}", "s");
    expect(verifyWebhookSignature('{"x":1}', "s", sig)).toBe(false);
  });

  it("returns false on missing or empty signature headers", () => {
    expect(verifyWebhookSignature("body", "s", undefined)).toBe(false);
    expect(verifyWebhookSignature("body", "s", null)).toBe(false);
    expect(verifyWebhookSignature("body", "s", "")).toBe(false);
  });
});

describe("WebhookAlertSender — happy path", () => {
  it("posts JSON with a signed header on first try and writes no deadletter", async () => {
    const db = makeDb();
    const fakeFetch = makeFakeFetch([{ status: 200 }]);
    const endpoint: WebhookEndpoint = {
      url: "https://example.com/hook",
      secret: "shared-secret-1",
    };
    const sender = new WebhookAlertSender({
      client: db.client,
      resolveEndpoint: async () => endpoint,
      fetch: fakeFetch.fetch,
    });

    await sender.send(envelope());

    expect(fakeFetch.calls).toHaveLength(1);
    expect(fakeFetch.calls[0]!.url).toBe(endpoint.url);
    const init = fakeFetch.calls[0]!.init;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    const sig = headers[WEBHOOK_SIGNATURE_HEADER]!;
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Verify the signature receivers will see is computed over the exact body.
    expect(
      verifyWebhookSignature(String(init.body), endpoint.secret, sig),
    ).toBe(true);
    expect(db.deadletters).toHaveLength(0);
  });
});

describe("WebhookAlertSender — retries on non-2xx", () => {
  it("retries up to 3 attempts on persistent 500 then deadletters", async () => {
    const db = makeDb();
    const fakeFetch = makeFakeFetch([
      { status: 500 },
      { status: 502 },
      { status: 503 },
    ]);
    const sleeps: number[] = [];
    const sender = new WebhookAlertSender({
      client: db.client,
      resolveEndpoint: async () => ({
        url: "https://example.com/hook",
        secret: "s",
      }),
      fetch: fakeFetch.fetch,
      // Pin jitter so exponential schedule is deterministic: jitter()=1 →
      // multiplier 1.0, sleeps land at exactly baseMs * 2^(attempt-1).
      retryOptions: {
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        jitter: () => 1,
      },
      generateId: () => "dl-500",
    });

    await expect(sender.send(envelope())).rejects.toBeInstanceOf(HttpError);
    expect(fakeFetch.calls).toHaveLength(3);
    // Three attempts → two between-attempt waits, exponential 1s, 2s.
    expect(sleeps).toEqual([1000, 2000]);
    expect(db.deadletters).toHaveLength(1);
    expect(db.deadletters[0]!.id).toBe("dl-500");
    expect(db.deadletters[0]!.attempts).toBe(3);
    expect(db.deadletters[0]!.error_message).toMatch(/503|webhook responded/);
  });

  it("retries on 4xx as well (non-2xx is non-2xx) and recovers if a later attempt is 2xx", async () => {
    const db = makeDb();
    const fakeFetch = makeFakeFetch([{ status: 418 }, { status: 204 }]);
    const sender = new WebhookAlertSender({
      client: db.client,
      resolveEndpoint: async () => ({
        url: "https://example.com/hook",
        secret: "s",
      }),
      fetch: fakeFetch.fetch,
      retryOptions: { sleep: async () => {}, jitter: () => 1 },
    });

    await sender.send(envelope());
    expect(fakeFetch.calls).toHaveLength(2);
    expect(db.deadletters).toHaveLength(0);
  });

  it("retries on a thrown network error then succeeds", async () => {
    const db = makeDb();
    const fakeFetch = makeFakeFetch([
      new Error("ECONNRESET"),
      { status: 200 },
    ]);
    const sender = new WebhookAlertSender({
      client: db.client,
      resolveEndpoint: async () => ({
        url: "https://example.com/hook",
        secret: "s",
      }),
      fetch: fakeFetch.fetch,
      retryOptions: { sleep: async () => {}, jitter: () => 1 },
    });

    await sender.send(envelope());
    expect(fakeFetch.calls).toHaveLength(2);
    expect(db.deadletters).toHaveLength(0);
  });
});

describe("WebhookAlertSender — deadletter edge cases", () => {
  it("deadletters with attempts=0 when no endpoint is registered for the user", async () => {
    const db = makeDb();
    const fakeFetch = makeFakeFetch([{ status: 200 }]);
    const sender = new WebhookAlertSender({
      client: db.client,
      resolveEndpoint: async () => null,
      fetch: fakeFetch.fetch,
      generateId: () => "dl-noep",
    });

    await sender.send(envelope());

    expect(fakeFetch.calls).toHaveLength(0);
    expect(db.deadletters).toHaveLength(1);
    expect(db.deadletters[0]!.id).toBe("dl-noep");
    expect(db.deadletters[0]!.attempts).toBe(0);
    expect(db.deadletters[0]!.error_message).toBe(
      "no webhook endpoint for user",
    );
  });

  it("deadletters with attempts=0 and never POSTs when the URL is not https", async () => {
    const db = makeDb();
    const fakeFetch = makeFakeFetch([{ status: 200 }]);
    const sender = new WebhookAlertSender({
      client: db.client,
      resolveEndpoint: async () => ({
        url: "http://example.com/hook",
        secret: "s",
      }),
      fetch: fakeFetch.fetch,
      generateId: () => "dl-http",
    });

    await sender.send(envelope());

    expect(fakeFetch.calls).toHaveLength(0);
    expect(db.deadletters).toHaveLength(1);
    expect(db.deadletters[0]!.attempts).toBe(0);
    expect(db.deadletters[0]!.error_message).toMatch(/non-https/);
  });

  it("preserves the alert payload inside the deadletter row on terminal failure", async () => {
    const db = makeDb();
    const fakeFetch = makeFakeFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    const fixedNow = new Date("2026-05-07T18:00:00Z");
    const sender = new WebhookAlertSender({
      client: db.client,
      resolveEndpoint: async () => ({
        url: "https://example.com/hook",
        secret: "s",
      }),
      fetch: fakeFetch.fetch,
      retryOptions: { sleep: async () => {}, jitter: () => 1 },
      generateId: () => "dl-payload",
      now: () => fixedNow,
    });

    await expect(
      sender.send(envelope({ alert_id: "alert-99", item_id: 7 })),
    ).rejects.toBeInstanceOf(HttpError);
    expect(db.deadletters).toHaveLength(1);
    const dl = db.deadletters[0]!;
    expect(dl.created_at).toEqual(fixedNow);
    const decoded = JSON.parse(dl.alert_payload) as AlertEnvelope;
    expect(decoded.alert_id).toBe("alert-99");
    expect(decoded.item_id).toBe(7);
    expect(decoded.user_id).toBe("u-1");
  });

  it("invokes onError on terminal failure", async () => {
    const db = makeDb();
    const fakeFetch = makeFakeFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    const errors: Array<{ err: unknown; label: string }> = [];
    const sender = new WebhookAlertSender({
      client: db.client,
      resolveEndpoint: async () => ({
        url: "https://example.com/hook",
        secret: "s",
      }),
      fetch: fakeFetch.fetch,
      retryOptions: { sleep: async () => {}, jitter: () => 1 },
      onError: (err, label) => errors.push({ err, label }),
      generateId: () => "dl-onerror",
    });

    await expect(sender.send(envelope())).rejects.toBeInstanceOf(HttpError);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.label).toBe("webhook-send");
  });
});
