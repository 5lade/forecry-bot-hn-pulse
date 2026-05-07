#!/usr/bin/env bash
# bin/test-completion.sh - acceptance test runner for HN Pulse
# Each criterion runs a SQL probe (or HTTP probe) against the live container.
# DATABASE_URL must be exported in the environment (the soak monitor passes it via docker exec).

set -uo pipefail
BOT_SLUG="hn-pulse"
LOG_DIR="${LOG_DIR:-/var/log/forecry-bot-${BOT_SLUG}}"
mkdir -p "${LOG_DIR}" 2>/dev/null || true

echo "Running acceptance tests for ${BOT_SLUG}..."
PASS=0
FAIL=0

run_psql () {
  psql -tA "${DATABASE_URL:-postgres://hnpulse@localhost/hnpulse}" -c "$1" 2>/dev/null
}

# === CRITERION 1: Poller liveness ===
# Most recent items.first_seen_at must be within last 5 minutes.
echo "[criterion-1] Poller liveness (most recent first_seen_at < 5m old)"
LAG_SECONDS=$(run_psql "SELECT EXTRACT(EPOCH FROM (NOW() - MAX(first_seen_at))) FROM items;")
if [ -n "${LAG_SECONDS}" ] && awk -v v="${LAG_SECONDS}" 'BEGIN{exit !(v < 300)}'; then
  echo "  PASS (lag=${LAG_SECONDS}s)"; PASS=$((PASS+1))
else
  echo "  FAIL (lag=${LAG_SECONDS:-NULL}s)"; FAIL=$((FAIL+1))
fi

# === CRITERION 2: Snapshot freshness ===
# At least 95% of tracked items <6h old have a snapshot in last 90s.
echo "[criterion-2] Snapshot freshness (>=95% of tracked items have snapshot <90s)"
PCT=$(run_psql "
WITH tracked AS (
  SELECT id FROM items WHERE first_seen_at > NOW() - INTERVAL '6 hours'
), fresh AS (
  SELECT DISTINCT item_id FROM item_snapshots
  WHERE taken_at > NOW() - INTERVAL '90 seconds'
)
SELECT COALESCE(ROUND(100.0 * COUNT(fresh.item_id) / NULLIF(COUNT(tracked.id), 0), 2), 0)
FROM tracked LEFT JOIN fresh ON fresh.item_id = tracked.id;")
if [ -n "${PCT}" ] && awk -v v="${PCT}" 'BEGIN{exit !(v >= 95)}'; then
  echo "  PASS (${PCT}%)"; PASS=$((PASS+1))
else
  echo "  FAIL (${PCT:-NULL}%)"; FAIL=$((FAIL+1))
fi

# === CRITERION 3: Scorer health ===
# Every snapshot in last hour has non-NULL p_front_page_6h.
echo "[criterion-3] Scorer health (no NULL p_front_page_6h in last hour)"
NULLS=$(run_psql "SELECT COUNT(*) FROM item_snapshots WHERE taken_at > NOW() - INTERVAL '1 hour' AND p_front_page_6h IS NULL;")
if [ "${NULLS:-1}" = "0" ]; then
  echo "  PASS"; PASS=$((PASS+1))
else
  echo "  FAIL (${NULLS} NULL rows)"; FAIL=$((FAIL+1))
fi

# === CRITERION 4: Alert latency ===
# Synthetic alerts table tracks round-trip — p95 latency must be <120s in last 24h.
echo "[criterion-4] Alert latency (p95 round-trip <120s in last 24h)"
P95=$(run_psql "
SELECT COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (delivered_at - matched_at))), 9999)
FROM alerts
WHERE matched_at > NOW() - INTERVAL '24 hours' AND alert_type = 'synthetic';")
if [ -n "${P95}" ] && awk -v v="${P95}" 'BEGIN{exit !(v < 120)}'; then
  echo "  PASS (p95=${P95}s)"; PASS=$((PASS+1))
else
  echo "  FAIL (p95=${P95:-NULL}s)"; FAIL=$((FAIL+1))
fi

# === CRITERION 5: Calibration drift ===
# Brier score over last 7 days <= 0.20.
echo "[criterion-5] Calibration drift (Brier score over 7d <=0.20)"
BRIER=$(run_psql "
SELECT COALESCE(ROUND(AVG(POWER(s.p_front_page_6h - (CASE WHEN i.reached_front_page THEN 1 ELSE 0 END), 2))::numeric, 4), 1)
FROM item_snapshots s
JOIN items i ON i.id = s.item_id
WHERE s.taken_at > NOW() - INTERVAL '7 days'
  AND i.first_seen_at < NOW() - INTERVAL '6 hours';")
if [ -n "${BRIER}" ] && awk -v v="${BRIER}" 'BEGIN{exit !(v <= 0.20)}'; then
  echo "  PASS (Brier=${BRIER})"; PASS=$((PASS+1))
else
  echo "  FAIL (Brier=${BRIER:-NULL})"; FAIL=$((FAIL+1))
fi

echo ""
echo "Result: ${PASS} pass, ${FAIL} fail"
[ $FAIL -eq 0 ]
