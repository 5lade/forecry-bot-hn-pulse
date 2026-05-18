import { randomUUID } from "node:crypto";
import type { ItemsQueryClient } from "../db/items.js";
import { telegramSendFailuresTotal } from "../metrics.js";
import { TokenBucketRateLimiter } from "../util/rate-limit.js";
import {
  retry,
  RetryAfterError,
  type RetryOptions,
} from "../util/retry.js";
import type { AlertEnvelope, AlertSender } from "./sender.js";

/**
 * Minimal subset of grammy's `bot.api` we need. Keeping this narrow lets
 * tests stub it without pulling in the whole Bot lifecycle.
 */
export interface TelegramApi {
  sendMessage(chatId: number | string, text: string): Promise<unknown>;
}

interface TelegramUserRow extends Record<string, unknown> {
  telegram_user_id: number | string | null;
}

export async function resolveTelegramChatId(
  client: ItemsQueryClient,
  userId: string,
): Promise<number | string | null> {
  const res = await client.query<TelegramUserRow>(
    `SELECT telegram_user_id
       FROM users
      WHERE id = $1
      LIMIT 1`,
    [userId],
  );
  const chatId = res.rows[0]?.telegram_user_id;
  if (chatId == null) return null;
  if (typeof chatId === "number") return chatId;
  const numeric = Number(chatId);
  return Number.isSafeInteger(numeric) ? numeric : chatId;
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatTelegramAlertMessage(env: AlertEnvelope): string {
  const p = env.payload;
  const hnUrl = `https://news.ycombinator.com/item?id=${env.item_id}`;
  const watch = `${p.watch_type}:${p.watch_value}`;

  switch (env.alert_type) {
    case "threshold":
      return [
        `HN Pulse: ${pct(p.p_front_page_6h)} front-page probability`,
        `Watch ${watch} crossed your ${p.threshold_pct}% threshold.`,
        `Item: ${hnUrl}`,
        "Next step: check title clarity and early comments while momentum is fresh.",
      ].join("\n");
    case "acceleration":
      return [
        `HN Pulse: momentum spike (${pct(p.delta_p_5min)} in 5 min)`,
        `Watch ${watch} is accelerating; current front-page probability is ${pct(p.p_front_page_6h)}.`,
        `Item: ${hnUrl}`,
        "Next step: engage quickly if comments are shaping the narrative.",
      ].join("\n");
    case "submitted":
      return [
        "HN Pulse: watched submitter posted a new item",
        `Watch ${watch} matched item ${env.item_id}.`,
        `Initial front-page probability: ${pct(p.p_front_page_6h)}.`,
        `Item: ${hnUrl}`,
      ].join("\n");
  }
}

const TELEGRAM_DEFAULT_RETRY: RetryOptions = {
  maxAttempts: 3,
  baseMs: 500,
  maxMs: 4000,
};

/**
 * grammy throws `GrammyError` with shape `{ error_code, description, parameters }`.
 * We don't bind to the class so the sender stays unit-testable without grammy.
 */
function readTelegramErrorCode(err: unknown): number | null {
  if (typeof err === "object" && err !== null && "error_code" in err) {
    const code = Number((err as { error_code: unknown }).error_code);
    return Number.isFinite(code) ? code : null;
  }
  return null;
}

function readRetryAfterSeconds(err: unknown): number | null {
  if (typeof err === "object" && err !== null && "parameters" in err) {
    const params = (err as { parameters?: { retry_after?: unknown } })
      .parameters;
    const ra = params?.retry_after;
    if (typeof ra === "number" && Number.isFinite(ra) && ra >= 0) return ra;
  }
  return null;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    const obj = err as { description?: unknown; message?: unknown };
    if (typeof obj.description === "string") return obj.description;
    if (typeof obj.message === "string") return obj.message;
  }
  return String(err);
}

function isTelegramRetryable(err: unknown): boolean {
  if (err instanceof RetryAfterError) return true;
  const code = readTelegramErrorCode(err);
  if (code == null) return false;
  return code >= 500 && code < 600;
}

export interface TelegramSenderDeps {
  api: TelegramApi;
  client: ItemsQueryClient;
  /** Maps an internal `user_id` to a Telegram chat id; null = no chat known. */
  resolveChatId(userId: string): Promise<number | string | null>;
  formatMessage(env: AlertEnvelope): string;
  retryOptions?: RetryOptions;
  /**
   * Optional outbound rate limiter — caps Telegram traffic at 25/sec global
   * and 1/sec per chat per Telegram's documented limits, queueing overflow
   * while preserving per-chat ordering. Omit in unit tests that don't need it.
   */
  rateLimiter?: TokenBucketRateLimiter;
  generateId?: () => string;
  now?: () => Date;
  log?: (msg: string) => void;
  onError?: (err: unknown, label: string) => void;
}

export class TelegramAlertSender implements AlertSender {
  constructor(private readonly deps: TelegramSenderDeps) {}

  async send(envelope: AlertEnvelope): Promise<void> {
    const chatId = await this.deps.resolveChatId(envelope.user_id);
    if (chatId == null) {
      await this.persistDeadletter(envelope, "no chat id for user", 0);
      return;
    }
    const text = this.deps.formatMessage(envelope);

    let attempts = 0;
    const sendWithRetry = async (): Promise<void> => {
      await retry(
        async () => {
          attempts += 1;
          try {
            await this.deps.api.sendMessage(chatId, text);
          } catch (err) {
            const code = readTelegramErrorCode(err);
            if (code === 429) {
              // Telegram tells us exactly how long to wait. Default to 1s if
              // the field is missing — never block forever, never spam.
              const retrySec = readRetryAfterSeconds(err) ?? 1;
              throw new RetryAfterError(
                retrySec * 1000,
                `telegram 429: retry_after=${retrySec}s`,
              );
            }
            throw err;
          }
        },
        {
          ...TELEGRAM_DEFAULT_RETRY,
          ...(this.deps.retryOptions ?? {}),
          isRetryable:
            this.deps.retryOptions?.isRetryable ?? isTelegramRetryable,
        },
      );
    };

    try {
      // Gate the whole send (including retries) through the rate limiter so
      // FIFO order per chat is preserved even when a 429 retry is in flight.
      if (this.deps.rateLimiter) {
        await this.deps.rateLimiter.submit(String(chatId), sendWithRetry);
      } else {
        await sendWithRetry();
      }
    } catch (err) {
      telegramSendFailuresTotal.inc();
      await this.persistDeadletter(envelope, formatErrorMessage(err), attempts);
      if (this.deps.onError) this.deps.onError(err, "telegram-send");
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
        `[deadletter] alert_id=${envelope.alert_id} user=${envelope.user_id} ` +
          `attempts=${attempts} error="${errorMessage}"`,
      );
    }
  }
}
