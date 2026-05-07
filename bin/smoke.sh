#!/usr/bin/env bash
# bin/smoke.sh - run all soak-criteria smoke scenarios (hn-pulse-p1-009).
#
# Iterates: healthy + break-1..break-5. Each run loads the fixture, applies
# the four migrations (including 0004_soak_views.sql), and verifies that
# the bash-script probe logic emits the expected PASS/FAIL pattern.
# Exits non-zero on any unexpected pattern.

set -euo pipefail
cd "$(dirname "$0")/.."

SCENARIOS=(healthy break-1 break-2 break-3 break-4 break-5)
for s in "${SCENARIOS[@]}"; do
  echo "============================================================"
  echo "smoke scenario: ${s}"
  echo "============================================================"
  node bin/smoke-fixture.mjs "${s}"
  echo
done
echo "[smoke] all scenarios passed."
