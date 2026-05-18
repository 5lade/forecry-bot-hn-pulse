#!/usr/bin/env bash
# bin/test-completion.sh - acceptance test runner for HN Pulse (stage-6 soak).
#
# Each criterion runs a SQL probe against the live container's Postgres.
# DATABASE_URL must be exported in the environment (the soak monitor passes
# it via docker exec). Probes read from helper views defined in
# db/migrations/0004_soak_views.sql so the script SQL stays trivial.
#
# Pass thresholds (kept identical to Spec.md "stage-6 soak"):
#   1. successful newstories heartbeat lag <300s
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
BLOCKED=0

run_psql () {
  psql -tA "${DATABASE_URL:-postgres://hnpulse@localhost/hnpulse}" -c "$1" 2>/dev/null
}

is_placeholder () {
  case "${1:-}" in
    ""|*placeholder*|"<"*">") return 0 ;;
    *) return 1 ;;
  esac
}

has_telegram_delivery () {
  ! is_placeholder "${TG_BOT_TOKEN:-}"
}

has_stripe_test_webhook () {
  case "${STRIPE_SECRET_KEY:-}" in
    sk_test_*) ;;
    *) return 1 ;;
  esac
  case "${STRIPE_WEBHOOK_SECRET:-}" in
    whsec_placeholder_for_soak|"") return 1 ;;
    whsec_*) return 0 ;;
    *) return 1 ;;
  esac
}

pass () {
  echo "  PASS ($1)"
  PASS=$((PASS+1))
}

fail () {
  echo "  FAIL ($1)"
  FAIL=$((FAIL+1))
}

blocked () {
  echo "  BLOCKED ($1)"
  BLOCKED=$((BLOCKED+1))
}

# === CRITERION 0: DB connectivity ===
echo "[criterion-0] DB connectivity (Postgres responds to SELECT 1)"
DB_OK=$(run_psql "SELECT 1;")
if [ "${DB_OK}" = "1" ]; then
  pass "SELECT 1"
else
  fail "SELECT 1 returned ${DB_OK:-NULL}"
fi

# === CRITERION 1: Poller liveness ===
echo "[criterion-1] Poller liveness (successful newstories heartbeat <300s old)"
LAG=$(run_psql "SELECT lag_seconds FROM v_poller_lag;")
if [ -n "${LAG}" ] && awk -v v="${LAG}" 'BEGIN{exit !(v < 300)}'; then
  pass "lag=${LAG}s"
else
  HEARTBEAT_TABLE=$(run_psql "SELECT to_regclass('public.service_heartbeats') IS NOT NULL;")
  if [ "${HEARTBEAT_TABLE}" != "t" ]; then
    blocked "service_heartbeats table unavailable; poller heartbeat migration not applied"
  else
    fail "lag=${LAG:-NULL}s"
  fi
fi

# === CRITERION 2: Snapshot freshness ===
echo "[criterion-2] Snapshot freshness (>=95% of tracked items have snapshot <90s)"
PCT=$(run_psql "SELECT freshness_pct FROM v_snapshot_freshness;")
if [ -n "${PCT}" ] && awk -v v="${PCT}" 'BEGIN{exit !(v >= 95)}'; then
  pass "${PCT}%"
else
  fail "${PCT:-NULL}%"
fi

# === CRITERION 3: Scorer health ===
echo "[criterion-3] Scorer health (no NULL p_front_page_6h in last hour)"
NULLS=$(run_psql "SELECT null_count FROM v_scorer_null_count_1h;")
if [ "${NULLS:-1}" = "0" ]; then
  pass "null_count=0"
else
  fail "null_count=${NULLS:-NULL}"
fi

# === CRITERION 4: Alert latency ===
echo "[criterion-4] Alert latency (p95 round-trip <120s in last 24h)"
if ! has_telegram_delivery; then
  blocked "Telegram delivery disabled or token missing in degraded soak"
else
  SYNTHETIC_ALERTS=$(run_psql "SELECT COUNT(*) FROM alerts WHERE matched_at > NOW() - INTERVAL '24 hours' AND alert_type = 'synthetic';")
  if [ "${SYNTHETIC_ALERTS:-0}" = "0" ]; then
    blocked "no synthetic alert fixture in last 24h; latency probe cannot distinguish idle from delayed delivery"
  else
    P95=$(run_psql "SELECT p95_seconds FROM v_alert_latency;")
    if [ -n "${P95}" ] && awk -v v="${P95}" 'BEGIN{exit !(v < 120)}'; then
      pass "p95=${P95}s"
    else
      fail "p95=${P95:-NULL}s"
    fi
  fi
fi

# === CRITERION 5: Calibration drift ===
echo "[criterion-5] Calibration drift (Brier score 7d <=0.20)"
CAL_ROWS=$(run_psql "SELECT COUNT(*) FROM item_snapshots s JOIN items i ON i.id = s.item_id WHERE s.taken_at > NOW() - INTERVAL '7 days' AND i.first_seen_at < NOW() - INTERVAL '6 hours' AND i.reached_front_page IS NOT NULL AND s.p_front_page_6h IS NOT NULL;")
if [ "${CAL_ROWS:-0}" = "0" ]; then
  blocked "insufficient mature labelled prediction data"
else
  BRIER=$(run_psql "SELECT ROUND(AVG(POWER(s.p_front_page_6h - (CASE WHEN i.reached_front_page THEN 1 ELSE 0 END), 2))::numeric, 4) FROM item_snapshots s JOIN items i ON i.id = s.item_id WHERE s.taken_at > NOW() - INTERVAL '7 days' AND i.first_seen_at < NOW() - INTERVAL '6 hours' AND i.reached_front_page IS NOT NULL AND s.p_front_page_6h IS NOT NULL;")
  if [ -n "${BRIER}" ] && awk -v v="${BRIER}" 'BEGIN{exit !(v <= 0.20)}'; then
    pass "Brier=${BRIER} rows=${CAL_ROWS}"
  else
    fail "Brier=${BRIER:-NULL} rows=${CAL_ROWS}"
  fi
fi

# === EXTERNAL: Stripe/webhook/payment ===
echo "[external-stripe] Stripe webhook/payment acceptance"
if has_stripe_test_webhook; then
  blocked "Stripe test credentials are present, but webhook/payment acceptance is not implemented in this script"
else
  blocked "Stripe disabled or missing real test webhook secret in degraded soak"
fi

echo ""
echo "Result: ${PASS} pass, ${FAIL} fail, ${BLOCKED} blocked"
if [ $FAIL -eq 0 ] && [ $BLOCKED -eq 0 ]; then
  exit 0
elif [ $FAIL -eq 0 ]; then
  exit 2
else
  exit 1
fi
