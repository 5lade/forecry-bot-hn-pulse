import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { ItemsQueryClient } from "../db/items.js";
import { HttpError, retry, type RetryOptions } from "../util/retry.js";
import type { AlertEnvelope, AlertSender } from "./sender.js";

/**
 * pulse-pro outbound webhook sender. Posts the alert envelope as JSON to a
 * user-supplied HTTPS URL, signs the body with HMAC-SHA256 against a shared
 * secret, retries up to 3x on non-2xx with exponential backoff, and persists
 * a row in `alerts_deadletter` when delivery is terminally unsuccessful.
 */

export const WEBHOOK_SIGNATURE_HEADER = "X-HnPulse-Signature";

const WEBHOOK_DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseMs: 1000,
  maxMs: 4000,
};

export interface WebhookEndpoint {
  url: string;
  secret: string;
}

export interface WebhookSenderDeps {
  client: ItemsQueryClient;
  /** Returns the webhook config for a user, or null if none is registered. */
  resolveEndpoint(userId: string): Promise<WebhookEndpoint | null>;
  /** Override fetch for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  retryOptions?: RetryOptions;
  generateId?: () => string;
  now?: () => Date;
  log?: (msg: string) => void;
  onError?: (err: unknown, label: string) => void;
}

export function signWebhookBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Constant-time signature check for receivers. Returns false on missing /
 * malformed header rather than throwing so callers can map that to a 401.
 */
export function verifyWebhookSignature(
  body: string,
  secret: string,
  signatureHeader: string | null | undefined,
): boolean {
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    return false;
  }
  const expected = signWebhookBody(body, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// "Retry up to 3x on non-2xx" per ticket: every non-2xx response is treated
// as retryable. Network/fetch errors (no HttpError attached) are also
// retryable since they are by definition transient until proven otherwise.
const isWebhookRetryable = (err: unknown): boolean => {
  if (err instanceof HttpError) return err.status < 200 || err.status >= 300;
  return true;
};

export class WebhookAlertSender implements AlertSender {
  constructor(private readonly deps: WebhookSenderDeps) {}

  async send(envelope: AlertEnvelope): Promise<void> {
    const endpoint = await this.deps.resolveEndpoint(envelope.user_id);
    if (endpoint == null) {
      await this.persistDeadletter(envelope, "no webhook endpoint for user", 0);
      return;
    }
    if (!/^https:\/\//i.test(endpoint.url)) {
      await this.persistDeadletter(
        envelope,
        `non-https webhook url rejected: ${endpoint.url}`,
        0,
      );
      return;
    }

    const body = JSON.stringify(envelope);
    const signature = signWebhookBody(body, endpoint.secret);
    const fetchImpl = this.deps.fetch ?? fetch;

    let attempts = 0;
    try {
      await retry(
        async () => {
          attempts += 1;
          const res = await fetchImpl(endpoint.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [WEBHOOK_SIGNATURE_HEADER]: signature,
            },
            body,
          });
          if (res.status < 200 || res.status >= 300) {
            throw new HttpError(res.status, `webhook responded ${res.status}`);
          }
        },
        {
          ...WEBHOOK_DEFAULT_RETRY,
          ...(this.deps.retryOptions ?? {}),
          isRetryable:
            this.deps.retryOptions?.isRetryable ?? isWebhookRetryable,
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.persistDeadletter(envelope, msg, attempts);
      if (this.deps.onError) this.deps.onError(err, "webhook-send");
      throw err;
    }
  }

  private async persistDeadletter(
    envelope: AlertEnvelope,
    errorMessage: string,
    attempts: number,
  ): Promise<void> {
    const id = (this.deps.generateId ?? (() => randomUUID()))();
    const now = (this.deps.now ?? (() => new Date()))();
    await this.deps.client.query(
      `INSERT INTO alerts_deadletter (id, alert_payload, error_message, attempts, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, JSON.stringify(envelope), errorMessage, attempts, now],
    );
    if (this.deps.log) {
      this.deps.log(
        `[webhook-deadletter] alert_id=${envelope.alert_id} user=${envelope.user_id} ` +
          `attempts=${attempts} error="${errorMessage}"`,
      );
    }
  }
}
