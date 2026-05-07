export interface HealthQueryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: T[] }>;
}

export interface HealthCheckResult {
  ok: boolean;
  detail?: string;
}

export interface HealthReport {
  ok: boolean;
  lastBatchAt: string | null;
  checks: {
    db: HealthCheckResult;
    poller: HealthCheckResult;
  };
}

export type LastBatchAtGetter = () => Date | null;

export const POLLER_LIVENESS_WINDOW_MS = 5 * 60 * 1000;

export async function checkDb(
  client: HealthQueryClient,
): Promise<HealthCheckResult> {
  try {
    await client.query("SELECT 1");
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `db unreachable: ${msg}` };
  }
}

export async function checkPollerLiveness(
  client: HealthQueryClient,
  now: () => Date = () => new Date(),
  windowMs: number = POLLER_LIVENESS_WINDOW_MS,
): Promise<HealthCheckResult> {
  try {
    const res = await client.query<{ first_seen_at: Date | string | null }>(
      "SELECT MAX(first_seen_at) AS first_seen_at FROM items",
    );
    const raw = res.rows[0]?.first_seen_at ?? null;
    if (raw === null) {
      return { ok: false, detail: "poller stalled: no items recorded" };
    }
    const lastSeen = raw instanceof Date ? raw : new Date(raw);
    const ageMs = now().getTime() - lastSeen.getTime();
    if (Number.isNaN(ageMs)) {
      return { ok: false, detail: "poller stalled: invalid first_seen_at" };
    }
    if (ageMs > windowMs) {
      return {
        ok: false,
        detail: `poller stalled: last item ${Math.floor(ageMs / 1000)}s ago`,
      };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, detail: `poller check failed: ${msg}` };
  }
}

export async function runHealthChecks(
  client: HealthQueryClient,
  now: () => Date = () => new Date(),
  getLastBatchAt: LastBatchAtGetter = () => null,
): Promise<HealthReport> {
  const db = await checkDb(client);
  const poller: HealthCheckResult = db.ok
    ? await checkPollerLiveness(client, now)
    : { ok: false, detail: "skipped: db unreachable" };
  const lastBatch = getLastBatchAt();
  return {
    ok: db.ok && poller.ok,
    lastBatchAt: lastBatch ? lastBatch.toISOString() : null,
    checks: { db, poller },
  };
}
