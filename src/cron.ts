import {
  DIGEST_HOUR_UTC,
  runDailyDigest,
  type DailyDigestDeps,
  type DailyDigestResult,
} from "./jobs/daily-digest.js";

export interface CronDeps {
  digest?: DailyDigestDeps;
  /** Override `Date.now`-style clock for tests. */
  now?: () => Date;
  /**
   * Override the timer used for scheduling. Defaults to setTimeout/clearTimeout.
   * Tests inject a controllable scheduler so we don't need fake timers.
   */
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  log?: (msg: string) => void;
  onError?: (err: unknown, label: string) => void;
}

export interface CronHandle {
  /** Stop the cron loop. Idempotent. */
  stop(): void;
}

/**
 * Milliseconds from `now` to the next instance of `hourUtc:00` in UTC.
 * If we are already past today's slot, the next slot is tomorrow.
 */
export function msUntilNextDailyUtc(now: Date, hourUtc: number): number {
  const target = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      0,
      0,
      0,
    ),
  );
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.getTime() - now.getTime();
}

/**
 * Starts the in-process cron loop. Currently the only scheduled job is the
 * 09:00 UTC daily digest. The loop computes the next firing time based on the
 * (injectable) clock and sleeps until it. After each fire, it reschedules.
 */
export function startCron(deps: CronDeps): CronHandle {
  const now = deps.now ?? (() => new Date());
  const setTimeoutFn = deps.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimeoutFn =
    deps.clearTimeoutImpl ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => {});
  const onError =
    deps.onError ??
    ((err: unknown, label: string) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[cron:${label}] ${msg}\n`);
    });

  let stopped = false;
  let activeHandle: unknown = null;

  const scheduleNextDigest = (): void => {
    if (stopped) return;
    if (!deps.digest) return;
    const delay = msUntilNextDailyUtc(now(), DIGEST_HOUR_UTC);
    log(`[cron] daily-digest scheduled in ${delay}ms`);
    activeHandle = setTimeoutFn(() => {
      void fireDigest();
    }, delay);
  };

  const fireDigest = async (): Promise<void> => {
    if (stopped || !deps.digest) return;
    try {
      const result: DailyDigestResult = await runDailyDigest(deps.digest);
      log(`[cron] daily-digest done: ${JSON.stringify(result)}`);
    } catch (err) {
      onError(err, "daily-digest");
    } finally {
      scheduleNextDigest();
    }
  };

  scheduleNextDigest();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (activeHandle != null) {
        clearTimeoutFn(activeHandle);
        activeHandle = null;
      }
    },
  };
}
