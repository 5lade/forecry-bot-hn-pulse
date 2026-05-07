# TODO — forecry-bot-hn-pulse

Tickets in rule8 fence format. Bert's builder picks the highest-priority `[ ]` ticket on each tick (P0 → P3, top-down). Mark `[x]` when complete and pushed.

---

## P0 — Blockers

- [x] hn-pulse-p0-001-node-init

```task
id: hn-pulse-p0-001-node-init
tier: P0
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: package.json, tsconfig.json, src/index.ts, .nvmrc
test_gate: smoke
post_deploy: none
risk: low
prompt: |
  Initialize Node 22 + TypeScript project skeleton.
  - package.json with deps: express, pg, grammy, stripe, pino, dotenv, zod;
    devDeps: typescript, @types/node, vitest, tsx.
  - Scripts: "build" (tsc), "dev" (tsx watch src/index.ts), "test" (vitest run),
    "start" (node dist/index.js).
  - tsconfig.json: target es2022, module NodeNext, moduleResolution NodeNext,
    strict, esModuleInterop, outDir dist, rootDir src.
  - .nvmrc with "22".
  - src/index.ts: minimal entrypoint that loads env via dotenv + zod schema and
    prints "hn-pulse ready" before exiting (real wiring lands in later tickets).
acceptance: |
  - `npm install` succeeds clean
  - `npm run build` produces dist/index.js
  - `node dist/index.js` prints "hn-pulse ready" and exits 0
  - tsconfig strict mode is on; no `any` in src/index.ts
```

- [x] hn-pulse-p0-002-db-schema

```task
id: hn-pulse-p0-002-db-schema
tier: P0
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: db/migrations/0001_init.sql, src/db/client.ts, src/db/migrate.ts
test_gate: pytest
post_deploy: none
risk: med
prompt: |
  Implement the Postgres schema from Spec.md (users, items, item_snapshots,
  watches, alerts) as db/migrations/0001_init.sql exactly as specified.
  Implement src/db/client.ts as a small pool-backed wrapper around `pg` and
  src/db/migrate.ts as an idempotent runner that applies any 000N_*.sql files
  not already recorded in a `schema_migrations` table.
  Add an `alerts.matched_at` and `alerts.delivered_at` column (Spec uses them
  for the latency criterion in bin/test-completion.sh).
acceptance: |
  - Running migrate against a clean Postgres DB creates all tables + indexes
  - Re-running migrate is a no-op
  - `bin/test-completion.sh` SQL probes parse cleanly against the schema
```

- [x] hn-pulse-p0-003-dockerfile-extend

```task
id: hn-pulse-p0-003-dockerfile-extend
tier: P0
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: Dockerfile, .dockerignore
test_gate: smoke
post_deploy: none
risk: low
prompt: |
  Extend the inherited Dockerfile so the production container is fully
  buildable: multi-stage (builder runs npm ci + npm run build, runtime stage
  copies dist + node_modules from --omit=dev), installs psql client (for
  bin/test-completion.sh), entrypoint runs migrations then `node dist/index.js`.
  Add .dockerignore that excludes node_modules, .env*, dist, .git.
acceptance: |
  - `docker build -t forecry-bot-hn-pulse .` succeeds
  - Final image is <300MB
  - Image boot logs show migrate running before main process
  - HEALTHCHECK still passes
```

- [ ] hn-pulse-p0-004-config-secrets

```task
id: hn-pulse-p0-004-config-secrets
tier: P0
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/config.ts, .env.example
test_gate: pytest
post_deploy: none
risk: low
prompt: |
  Centralize all env config in src/config.ts using zod for validation. Required:
  DATABASE_URL, TG_BOT_TOKEN, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  PUBLIC_URL, NODE_ENV, LOG_LEVEL. Throw a descriptive error if any required
  var is missing. Also publish .env.example with all keys (no secrets).
acceptance: |
  - Missing required env aborts startup with one clear error message
  - .env.example is committed and matches src/config.ts schema
  - Vitest covers happy path + each missing-key path
```

- [ ] hn-pulse-p0-005-healthcheck

```task
id: hn-pulse-p0-005-healthcheck
tier: P0
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/server.ts, src/health.ts, Dockerfile
test_gate: pytest
post_deploy: none
risk: low
prompt: |
  Implement an Express server listening on PORT (default 8080) with GET /health
  returning 200 when (a) DB is reachable and (b) most recent items.first_seen_at
  is < 5 minutes old (the "poller liveness" criterion). Otherwise 503 with a
  JSON body describing which check failed. Update Dockerfile HEALTHCHECK to
  `curl -fsS http://localhost:8080/health || exit 1`.
acceptance: |
  - GET /health returns 200 in healthy state
  - Returns 503 + JSON when DB is down or poller has stalled
  - Container HEALTHCHECK transitions to healthy within 60s of start
```

---

## P1 — Core features

- [ ] hn-pulse-p1-001-hn-poller

```task
id: hn-pulse-p1-001-hn-poller
tier: P1
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/poller/hn.ts, src/poller/index.ts, src/db/items.ts
test_gate: pytest
post_deploy: none
risk: med
prompt: |
  Implement the HN poller per Spec.md §1. Polls /v0/newstories.json every 30s,
  diffs vs last seen, fetches new items via /v0/item/{id}.json, persists into
  items + first item_snapshots row. Also re-fetches every item < 6h old every
  60s and writes a fresh snapshot. Includes exponential backoff on 5xx and a
  `lastBatchAt` metric exposed on the health server.
acceptance: |
  - Vitest covers diff-against-seen, new-item insert, retry-on-5xx
  - Running locally for 5 minutes against the real HN API populates items +
    item_snapshots and items.first_seen_at lag stays <60s
```

- [ ] hn-pulse-p1-002-feature-extractor

```task
id: hn-pulse-p1-002-feature-extractor
tier: P1
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/scorer/features.ts
test_gate: pytest
post_deploy: none
risk: low
prompt: |
  Implement feature extraction per Spec.md §2: upvotes, comments, age_minutes,
  score_velocity (Δscore over Δt vs previous snapshot for same item),
  comment_velocity, posting hour UTC, day of week, domain, domain_reputation
  (cached lookup with default 0), title_length, has_show_hn, has_ask_hn,
  author_karma_bucket. Return a typed FeatureRow.
acceptance: |
  - Vitest covers each feature with deterministic fixtures
  - Velocity is 0 when previous snapshot is missing
  - has_show_hn/has_ask_hn are case-insensitive on title prefix
```

- [ ] hn-pulse-p1-003-scorer-baseline

```task
id: hn-pulse-p1-003-scorer-baseline
tier: P1
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/scorer/baseline.ts, src/scorer/index.ts
test_gate: pytest
post_deploy: none
risk: med
prompt: |
  Ship a hand-weighted logistic scorer as v1: probability is sigmoid of a
  weighted sum of normalized features (with the published HN ranking weight
  ~1.8 on score and a strong age penalty). Outputs p_front_page_6h and
  delta_p_5min. Persist back to item_snapshots.p_front_page_6h on each insert.
  Real model training lands in the next ticket — this exists so the alert
  dispatcher and acceptance tests can run in soak from day one.
acceptance: |
  - Every snapshot inserted has a non-NULL p_front_page_6h
  - Probabilities are in [0, 1]
  - delta_p_5min is computed against the snapshot from ~5 minutes ago for the
    same item, or 0 if not available
```

- [ ] hn-pulse-p1-004-scorer-train

```task
id: hn-pulse-p1-004-scorer-train
tier: P1
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/scorer/train.ts, models/logistic-v1.json
test_gate: pytest
post_deploy: none
risk: med
prompt: |
  Backfill 60 days of HN data via /v0/maxitem and /v0/item, label each item
  "made front page within 6h" by snapshot replay or the public BigQuery
  dataset, train a logistic regression with L2 regularization, persist
  weights to models/logistic-v1.json. Update src/scorer/index.ts to load
  the trained weights at boot, falling back to baseline if missing.
acceptance: |
  - Train script runs end-to-end and writes models/logistic-v1.json
  - Held-out 7-day ROC AUC >= 0.70 (per Spec.md success metrics)
  - At runtime the trained model is loaded; baseline path is unit-tested
```

- [ ] hn-pulse-p1-005-alert-dispatcher

```task
id: hn-pulse-p1-005-alert-dispatcher
tier: P1
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/alerts/dispatcher.ts, src/alerts/match.ts, src/db/watches.ts
test_gate: pytest
post_deploy: none
risk: med
prompt: |
  On every new item_snapshots insert, look up matching watches (by item id,
  domain, or submitter), evaluate user threshold, and enqueue a Telegram
  alert. Suppress duplicates per (user_id, item_id, alert_type) within 30
  minutes. Record alert into alerts table with matched_at; delivered_at is
  filled by the Telegram sender. Three alert types: 'threshold', 'acceleration'
  (delta_p_5min > 0.15), 'submitted' (item with watched submitter just posted).
acceptance: |
  - Vitest covers all three alert types and dedup window
  - Synthetic watch + matching snapshot results in exactly one alerts row
  - alerts.delivered_at is populated within 5s in the happy path
```

- [ ] hn-pulse-p1-006-telegram-bot

```task
id: hn-pulse-p1-006-telegram-bot
tier: P1
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/bot/index.ts, src/bot/commands/*.ts
test_gate: pytest
post_deploy: none
risk: med
prompt: |
  Implement the grammy-based Telegram bot with commands:
  /start (creates user row), /watch (parses item-id|domain|@submitter),
  /unwatch (lists watches with inline buttons), /threshold (validates 0-100),
  /digest (toggles digest_opt_in), /me (shows tier + watches + last alerts),
  /upgrade (creates Stripe checkout session), /cancel (returns billing portal).
  Long-poll for MVP; webhook mode behind FEATURE_TG_WEBHOOK env flag.
acceptance: |
  - Each command path has a unit test using grammy's test helpers
  - Free tier enforces 2-watch limit with a clear error reply
  - /start is idempotent
```

- [ ] hn-pulse-p1-007-stripe-webhook

```task
id: hn-pulse-p1-007-stripe-webhook
tier: P1
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/billing/webhook.ts, src/billing/checkout.ts, src/server.ts
test_gate: pytest
post_deploy: none
risk: high
prompt: |
  POST /stripe/webhook on the Express server. Verifies the signature using
  STRIPE_WEBHOOK_SECRET. Handles checkout.session.completed,
  customer.subscription.updated, customer.subscription.deleted. Maps
  Stripe price IDs (PULSE_PRICE_ID, PULSE_PRO_PRICE_ID env) to users.tier.
  /upgrade command creates a checkout session; /cancel returns billing portal URL.
acceptance: |
  - Webhook signature verification rejects forged events
  - Subscription lifecycle correctly transitions tier free→pulse→canceled
  - Vitest uses Stripe's test fixtures for each event type
```

- [ ] hn-pulse-p1-008-daily-digest

```task
id: hn-pulse-p1-008-daily-digest
tier: P1
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/jobs/daily-digest.ts, src/cron.ts
test_gate: pytest
post_deploy: none
risk: low
prompt: |
  Cron at 09:00 UTC iterates digest_opt_in users, builds yesterday's tracked
  items + final ranks + predicted-vs-realized, sends a single Telegram message
  per user with hits/misses and a calibration link. Skip free-tier users.
acceptance: |
  - Vitest covers digest generation against a fixture DB
  - Run twice on same day is idempotent (per-user "digest_sent_at")
  - Empty users (no watches) get no message
```

- [ ] hn-pulse-p1-009-soak-criteria-views

```task
id: hn-pulse-p1-009-soak-criteria-views
tier: P1
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: db/migrations/0002_soak_views.sql, bin/test-completion.sh
test_gate: smoke
post_deploy: none
risk: low
prompt: |
  Make sure every probe in bin/test-completion.sh runs against the real schema.
  Where convenient, materialize helper views (e.g. v_alert_latency,
  v_calibration_brier_7d) so the script SQL stays readable. Keep the existing
  pass thresholds (lag<300s, >=95% snapshot freshness, no NULL probabilities,
  alert p95 <120s, Brier <=0.20).
acceptance: |
  - All five criteria emit PASS against a healthy fixture DB
  - All five criteria correctly emit FAIL when their underlying invariant breaks
```

---

## P2 — Polish

- [ ] hn-pulse-p2-001-structured-logging

```task
id: hn-pulse-p2-001-structured-logging
tier: P2
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/log.ts, src/**/*.ts (call sites)
test_gate: smoke
post_deploy: none
risk: low
prompt: |
  Wire pino as the single logger. Bind item_id and user_id when available.
  Log levels: debug for snapshot inserts, info for alerts, warn for retries,
  error for hard failures. JSON output in production.
acceptance: |
  - No raw console.log left in src/ except scripts in /bin
  - Logs include level, time, msg, plus context fields (item_id where relevant)
```

- [ ] hn-pulse-p2-002-retry-policy

```task
id: hn-pulse-p2-002-retry-policy
tier: P2
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/poller/hn.ts, src/alerts/telegram.ts, src/util/retry.ts
test_gate: pytest
post_deploy: none
risk: low
prompt: |
  Centralize retry logic: exponential backoff with jitter, max 5 attempts on
  HN API; max 3 attempts on Telegram with respect for 429 retry-after. Persist
  failed alerts to a deadletter table for later replay.
acceptance: |
  - Vitest covers backoff schedule and 429 handling
  - Deadletter row is created on terminal failure
```

- [ ] hn-pulse-p2-003-rate-limit

```task
id: hn-pulse-p2-003-rate-limit
tier: P2
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/alerts/telegram.ts
test_gate: pytest
post_deploy: none
risk: low
prompt: |
  Cap outbound Telegram messages at 25/sec globally and 1/sec per chat (Telegram
  limits). Queue overflow into a token-bucket and drain on tick.
acceptance: |
  - Burst test of 200 messages does not 429
  - Per-chat ordering is preserved
```

- [ ] hn-pulse-p2-004-metrics-prom

```task
id: hn-pulse-p2-004-metrics-prom
tier: P2
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/metrics.ts, src/server.ts
test_gate: smoke
post_deploy: none
risk: low
prompt: |
  Expose GET /metrics with Prometheus format. Counters: hn_items_seen_total,
  alerts_sent_total{type}, telegram_send_failures_total. Gauges: poller_lag_seconds,
  active_watches, model_brier_7d.
acceptance: |
  - GET /metrics returns text/plain prometheus format
  - All listed metrics are present after 1 minute of traffic
```

- [ ] hn-pulse-p2-005-deep-health

```task
id: hn-pulse-p2-005-deep-health
tier: P2
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/health.ts
test_gate: pytest
post_deploy: none
risk: low
prompt: |
  Extend /health into /health (cheap) and /healthz (deep): deep checks DB
  connectivity, last poll lag, Telegram bot getMe, Stripe ping. Keep cheap
  health bound to under 50ms.
acceptance: |
  - /health < 50ms p99 in vitest benchmark
  - /healthz fails when any dependency is down and identifies which
```

---

## P3 — Nice-to-have (deferred)

- [ ] hn-pulse-p3-001-weekly-calibration

```task
id: hn-pulse-p3-001-weekly-calibration
tier: P3
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/jobs/weekly-calibration.ts
test_gate: pytest
post_deploy: none
risk: low
prompt: |
  pulse-pro tier weekly calibration recap (Brier, ROC AUC, hit rate by
  threshold band). Sends Telegram message with a link to a hosted PNG plot.
acceptance: |
  - Runs Mondays 09:00 UTC for pulse-pro users only
  - Plot is reachable and decodes as PNG
```

- [ ] hn-pulse-p3-002-api-key

```task
id: hn-pulse-p3-002-api-key
tier: P3
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/api/keys.ts, src/api/routes.ts
test_gate: pytest
post_deploy: none
risk: med
prompt: |
  pulse-pro API: GET /v1/items/:id, GET /v1/items?domain=, GET /v1/me; bearer
  token auth via api_keys table; 60 req/min per key.
acceptance: |
  - 401 on missing/invalid key, 429 over limit
  - Vitest covers all three routes
```

- [ ] hn-pulse-p3-003-webhook-out

```task
id: hn-pulse-p3-003-webhook-out
tier: P3
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/alerts/webhook-out.ts
test_gate: pytest
post_deploy: none
risk: low
prompt: |
  pulse-pro: deliver alerts to user-supplied HTTPS webhook URL with HMAC
  signature. Retry up to 3x on non-2xx with exponential backoff.
acceptance: |
  - Signature verifies against shared secret
  - 3 attempts then deadletter on persistent failure
```

- [ ] hn-pulse-p3-004-annual-billing

```task
id: hn-pulse-p3-004-annual-billing
tier: P3
block: none
target: pc
cwd: /tmp/forecry-bot-hn-pulse
target_files: src/billing/checkout.ts, src/bot/commands/upgrade.ts
test_gate: pytest
post_deploy: none
risk: low
prompt: |
  Add annual price IDs (2 months free) and offer them in the /upgrade
  Telegram inline keyboard.
acceptance: |
  - Both monthly and annual checkout sessions create subscriptions correctly
  - Tier transition logic in webhook handles annual → monthly downgrades
```
