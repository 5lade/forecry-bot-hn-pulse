#!/usr/bin/env bash
# bin/test-completion.sh - acceptance test runner for HN Pulse (stage-6 soak).
#
# Each criterion runs a SQL probe against the live container's Postgres.
# DATABASE_URL must be exported in the environment (the soak monitor passes
# it via docker exec). Probes read from helper views defined in
# db/migrations/0004_soak_views.sql so the script SQL stays trivial.
#
# Pass thresholds (kept identical to Spec.md "stage-6 soak"):
#   1. lag <300s
#   2. snapshot freshness >=95%
#   3. zero NULL p_front_page_6h in last hour
#   4. alert p95 round-trip <120s
#   5. Brier score over 7d <=0.20

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
echo "[criterion-1] Poller liveness (most recent first_seen_at <300s old)"
LAG=$(run_psql "SELECT lag_seconds FROM v_poller_lag;")
if [ -n "${LAG}" ] && awk -v v="${LAG}" 'BEGIN{exit !(v < 300)}'; then
  echo "  PASS (lag=${LAG}s)"; PASS=$((PASS+1))
else
  echo "  FAIL (lag=${LAG:-NULL}s)"; FAIL=$((FAIL+1))
fi

# === CRITERION 2: Snapshot freshness ===
echo "[criterion-2] Snapshot freshness (>=95% of tracked items have snapshot <90s)"
PCT=$(run_psql "SELECT freshness_pct FROM v_snapshot_freshness;")
if [ -n "${PCT}" ] && awk -v v="${PCT}" 'BEGIN{exit !(v >= 95)}'; then
  echo "  PASS (${PCT}%)"; PASS=$((PASS+1))
else
  echo "  FAIL (${PCT:-NULL}%)"; FAIL=$((FAIL+1))
fi

# === CRITERION 3: Scorer health ===
echo "[criterion-3] Scorer health (no NULL p_front_page_6h in last hour)"
NULLS=$(run_psql "SELECT null_count FROM v_scorer_null_count_1h;")
if [ "${NULLS:-1}" = "0" ]; then
  echo "  PASS (null_count=0)"; PASS=$((PASS+1))
else
  echo "  FAIL (null_count=${NULLS:-NULL})"; FAIL=$((FAIL+1))
fi

# === CRITERION 4: Alert latency ===
echo "[criterion-4] Alert latency (p95 round-trip <120s in last 24h)"
P95=$(run_psql "SELECT p95_seconds FROM v_alert_latency;")
if [ -n "${P95}" ] && awk -v v="${P95}" 'BEGIN{exit !(v < 120)}'; then
  echo "  PASS (p95=${P95}s)"; PASS=$((PASS+1))
else
  echo "  FAIL (p95=${P95:-NULL}s)"; FAIL=$((FAIL+1))
fi

# === CRITERION 5: Calibration drift ===
echo "[criterion-5] Calibration drift (Brier score 7d <=0.20)"
BRIER=$(run_psql "SELECT brier_score FROM v_calibration_brier_7d;")
if [ -n "${BRIER}" ] && awk -v v="${BRIER}" 'BEGIN{exit !(v <= 0.20)}'; then
  echo "  PASS (Brier=${BRIER})"; PASS=$((PASS+1))
else
  echo "  FAIL (Brier=${BRIER:-NULL})"; FAIL=$((FAIL+1))
fi

echo ""
echo "Result: ${PASS} pass, ${FAIL} fail"
[ $FAIL -eq 0 ]
