# Acceptance tests for HN Pulse

Pass criteria:

- [ ] **Poller liveness** — HN poller has fetched at least 1 batch of `/newstories` in the last 5 minutes (most recent `items.first_seen_at` < now − 5m). Threshold: 100% of daily checks must pass.
- [ ] **Snapshot freshness** — At least 95% of tracked items younger than 6 hours have a snapshot taken in the last 90 seconds.
- [ ] **Scorer health** — Every snapshot inserted in the last hour has a non-NULL `p_front_page_6h` value (model never silently skipped).
- [ ] **Alert latency** — Synthetic test watch fires an alert that lands in the test Telegram chat within 120 seconds of the matching snapshot, measured round-trip.
- [ ] **Calibration drift** — Brier score on the last 7 days of predictions ≤ 0.20 (above 0.25 means the model has decayed and needs retraining).

3 consecutive days passing + zero crashes = early promotion to forecry.
30 days clean + final pass = standard promotion.

Fail criteria:
- > 3 crashes in any 24h
- Unresponsive > 30 min
- > 2GB RAM or 50% CPU sustained
- Output deviates from expected pattern > 20% of samples

`bin/test-completion.sh` runs the criteria checks. Doctor invokes it daily during soak.
