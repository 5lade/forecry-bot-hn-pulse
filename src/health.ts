import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface HealthQueryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: T[] }>;
}

export type DependencyStatus = "ok" | "down";

export interface DependencyCheck {
  status: DependencyStatus;
  reason?: string;
}

export interface LivenessReport {
  status: "ok";
  uptime: number;
  version: string;
}

export type ReadinessCheckName = "db" | "poller" | "telegram" | "stripe";

export interface ReadinessReport {
  ok: boolean;
  checks: Record<ReadinessCheckName, DependencyCheck>;
}

const PROCESS_STARTED_AT_MS = Date.now();

let cachedVersion: string | null = null;

function readPackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  try {
    // src/health.ts → ../package.json; dist/health.js → ../package.json.
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(resolve(here, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    cachedVersion =
      typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    cachedVersion = "unknown";
  }
  return cachedVersion;
}

export interface LivenessOptions {
  now?: () => number;
  startedAt?: number;
  version?: string;
}

/**
 * Cheap liveness probe — strictly synchronous, no I/O. Safe to call on the
 * /health hot path with a tight latency budget.
 */
export function liveness(opts: LivenessOptions = {}): LivenessReport {
  const now = opts.now ? opts.now() : Date.now();
  const startedAt = opts.startedAt ?? PROCESS_STARTED_AT_MS;
  const version = opts.version ?? readPackageVersion();
  return {
    status: "ok",
    uptime: Math.max(0, (now - startedAt) / 1000),
    version,
  };
}

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_POLL_LAG_MULTIPLIER = 3;
export const DEFAULT_DEEP_CHECK_TIMEOUT_MS = 2_000;

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkDb(
  client: HealthQueryClient,
  timeoutMs: number = DEFAULT_DEEP_CHECK_TIMEOUT_MS,
): Promise<DependencyCheck> {
  try {
    await withTimeout(() => client.query("SELECT 1"), timeoutMs, "db SELECT 1");
    return { status: "ok" };
  } catch (err) {
    return { status: "down", reason: reasonOf(err) };
  }
}

export interface PollerLagCheckOptions {
  getLastBatchAt: () => Date | null;
  intervalMs?: number;
  multiplier?: number;
  now?: () => Date;
}

export function checkPollerLag(opts: PollerLagCheckOptions): DependencyCheck {
  const intervalMs = opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const multiplier = opts.multiplier ?? DEFAULT_POLL_LAG_MULTIPLIER;
  const now = (opts.now ?? (() => new Date()))();
  const last = opts.getLastBatchAt();
  if (!last) {
    return { status: "down", reason: "no successful poll recorded yet" };
  }
  const lagMs = now.getTime() - last.getTime();
  if (Number.isNaN(lagMs)) {
    return { status: "down", reason: "invalid last poll timestamp" };
  }
  const threshold = intervalMs * multiplier;
  if (lagMs > threshold) {
    return {
      status: "down",
      reason: `poll lag ${Math.round(lagMs / 1000)}s exceeds ${Math.round(
        threshold / 1000,
      )}s`,
    };
  }
  return { status: "ok" };
}

export type TelegramGetMe = () => Promise<unknown>;
export type StripePing = () => Promise<unknown>;

export async function checkTelegram(
  getMe: TelegramGetMe,
  timeoutMs: number = DEFAULT_DEEP_CHECK_TIMEOUT_MS,
): Promise<DependencyCheck> {
  try {
    await withTimeout(getMe, timeoutMs, "telegram getMe");
    return { status: "ok" };
  } catch (err) {
    return { status: "down", reason: reasonOf(err) };
  }
}

export async function checkStripe(
  ping: StripePing,
  timeoutMs: number = DEFAULT_DEEP_CHECK_TIMEOUT_MS,
): Promise<DependencyCheck> {
  try {
    await withTimeout(ping, timeoutMs, "stripe ping");
    return { status: "ok" };
  } catch (err) {
    return { status: "down", reason: reasonOf(err) };
  }
}

export interface ReadinessDeps {
  client: HealthQueryClient;
  getLastBatchAt: () => Date | null;
  telegramGetMe: TelegramGetMe;
  stripePing: StripePing;
  now?: () => Date;
  pollIntervalMs?: number;
  pollLagMultiplier?: number;
  timeoutMs?: number;
}

export async function runReadiness(
  deps: ReadinessDeps,
): Promise<ReadinessReport> {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_DEEP_CHECK_TIMEOUT_MS;
  const [db, telegram, stripe] = await Promise.all([
    checkDb(deps.client, timeoutMs),
    checkTelegram(deps.telegramGetMe, timeoutMs),
    checkStripe(deps.stripePing, timeoutMs),
  ]);
  const poller = checkPollerLag({
    getLastBatchAt: deps.getLastBatchAt,
    intervalMs: deps.pollIntervalMs,
    multiplier: deps.pollLagMultiplier,
    now: deps.now,
  });
  const ok =
    db.status === "ok" &&
    poller.status === "ok" &&
    telegram.status === "ok" &&
    stripe.status === "ok";
  return { ok, checks: { db, poller, telegram, stripe } };
}

export function failedDependencies(report: ReadinessReport): ReadinessCheckName[] {
  return (Object.keys(report.checks) as ReadinessCheckName[]).filter(
    (name) => report.checks[name].status === "down",
  );
}
