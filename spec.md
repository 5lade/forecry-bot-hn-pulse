# HN Pulse — Spec

A Forecry Bot Factory production. Real-time Hacker News front-page probability predictor.

## Mission

Tell indie hackers, founders, and growth marketers — within 60 seconds of a submission appearing on Hacker News `/newest` — what the probability is that the post will reach the front page (top 30) within the next 6 hours, and ping them when probabilities cross thresholds they care about.

## Why this exists

The HN ranking algorithm leans heavily on early upvote velocity: the first 30 minutes carry roughly 35% of the front-page outcome. By the time a submitter notices momentum on `/newest` it is often already too late to intervene (e.g. ask network for support, fix a misleading title, post a clarifying comment). HN Pulse closes that observation gap.

## Architecture

```
   ┌────────────────────────┐
   │ HN API poller          │  every 30s, /newstories + /v0/item
   │ (stateless, retries)   │
   └────────┬───────────────┘
            │ items, snapshots
   ┌────────▼───────────────┐    ┌────────────────────┐
   │ Ingest worker          │───▶│ Postgres           │
   │ - dedupes              │    │ items, snapshots,  │
   │ - extracts features    │    │ users, watches,    │
   │ - persists snapshots   │    │ alerts             │
   └────────┬───────────────┘    └────────┬───────────┘
            │ feature row                 │
   ┌────────▼───────────────┐    ┌────────▼───────────┐
   │ Scorer                 │    │ Daily digest job   │
   │ - logistic model       │    │ - calibration      │
   │ - probability + p(rise)│    │ - hits/misses      │
   └────────┬───────────────┘    └────────────────────┘
            │ probability
   ┌────────▼───────────────┐
   │ Alert dispatcher       │
   │ - matches against      │
   │   user watches         │
   │ - rate-limits          │
   │ - fans out to Telegram │
   └────────────────────────┘

   ┌────────────────────────┐
   │ Telegram bot           │  /watch /unwatch /threshold /digest /me
   │ python-telegram-bot    │
   └────────────────────────┘

   ┌────────────────────────┐
   │ Stripe webhook         │  subscription state → users.tier
   └────────────────────────┘
```

Single Node.js (TypeScript) process for MVP. Postgres (managed). Stripe for billing. Telegram for delivery. No public website beyond a one-page landing.

## Components

### 1. HN API poller

- Polls `https://hacker-news.firebaseio.com/v0/newstories.json` every 30 seconds.
- Diffs against last seen IDs, fetches new items via `/v0/item/{id}.json`.
- Also re-fetches every tracked item (any item < 6h old) every 60 seconds to capture upvote/comment trajectory.
- Stateless; survives restarts by reading the most recent `seen_at` from `items` table.

### 2. Ingest worker

- Persists each fetched item as an `items` row plus a new `item_snapshots` row.
- Extracts features: upvotes, comments, age_minutes, score_velocity (Δscore over Δt), comment_velocity, posting hour UTC, day of week, domain (extracted from URL), domain reputation (cached lookup), title length, has_show_hn flag, has_ask_hn flag, author karma bucket.

### 3. Scorer

- Logistic regression model trained on a backfill of 60 days of HN data labelled "made front page within 6h" (yes/no).
- Inputs: the feature row from the ingest worker.
- Outputs:
  - `p_front_page_6h` (0..1)
  - `delta_p_5min` (probability change over last 5 minutes — used to detect acceleration)
- Re-scores every tracked item on every snapshot. Stores result on the snapshot row.

### 4. Alert dispatcher

- Watches the `item_snapshots` insert stream.
- For each new snapshot, fetches matching `watches` rows (by item id, by domain, or by user-id-of-submitter) and checks thresholds.
- Sends one alert per (user, item, alert_type) combination at most every 30 minutes.
- Delivers via Telegram with deep link to the HN item, current rank, current probability, and next-step suggestions ("Title is on the long side — consider editing if score is still <5"). 

### 5. Telegram bot

Commands:
- `/start` — onboarding, links Telegram user to a (free) account
- `/watch <hn-username|domain|item-id>` — add a watch
- `/unwatch <id>` — remove a watch
- `/threshold <0-100>` — set personal probability threshold for alerts (default 60%)
- `/digest` — toggle daily digest opt-in (default on)
- `/me` — show plan, watches, recent alerts
- `/upgrade` — Stripe checkout link
- `/cancel` — Stripe billing portal link

### 6. Stripe webhook

- Listens for `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
- Updates `users.tier` (free / pulse / pulse-pro).
- Plans:
  - **free**: up to 2 watches, alerts on >80% probability only, no digest.
  - **pulse** ($19/mo): 25 watches, configurable thresholds, daily digest, acceleration alerts.
  - **pulse-pro** ($49/mo): unlimited watches, real-time webhook delivery, weekly calibration report, API key.

### 7. Daily digest job

- Cron at 09:00 UTC.
- For each opted-in user, gathers yesterday's tracked items + their final ranks + the model's predicted probability at submission time.
- Computes calibration (predicted vs. realized) over rolling 30 days.
- Sends one Telegram message with hit/miss highlights and a link to a hosted calibration plot.

## Data model (Postgres)

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  telegram_user_id BIGINT UNIQUE NOT NULL,
  tier TEXT NOT NULL DEFAULT 'free',
  threshold_pct INT NOT NULL DEFAULT 60,
  digest_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
  stripe_customer_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE items (
  id INT PRIMARY KEY,            -- HN item id
  by TEXT,
  title TEXT,
  url TEXT,
  domain TEXT,
  posted_at TIMESTAMPTZ NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  reached_front_page BOOLEAN,
  reached_front_page_at TIMESTAMPTZ
);

CREATE TABLE item_snapshots (
  item_id INT REFERENCES items(id),
  taken_at TIMESTAMPTZ NOT NULL,
  rank INT,                      -- null if not on front page
  score INT,
  comments INT,
  score_velocity NUMERIC,
  comment_velocity NUMERIC,
  p_front_page_6h NUMERIC,
  delta_p_5min NUMERIC,
  PRIMARY KEY (item_id, taken_at)
);

CREATE TABLE watches (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  watch_type TEXT NOT NULL,      -- 'item' | 'domain' | 'submitter'
  watch_value TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE alerts (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  item_id INT REFERENCES items(id),
  alert_type TEXT NOT NULL,      -- 'threshold' | 'acceleration' | 'submitted'
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  payload JSONB
);

CREATE INDEX ON items (first_seen_at);
CREATE INDEX ON item_snapshots (taken_at);
CREATE INDEX ON watches (watch_type, watch_value);
CREATE INDEX ON alerts (user_id, item_id, alert_type, sent_at DESC);
```

## Integrations

- **Hacker News Firebase API** — read-only, public, no auth.
- **Telegram Bot API** — bot token via env, long-poll for MVP, webhooks for production.
- **Stripe** — checkout + webhook for subscription state.
- **Postgres** — managed (Neon or Supabase).
- **GHCR** — Docker image registry (already wired via `.github/workflows/build-image.yml`).

## User stories

1. As an indie hacker launching today, I want to register my submission with `/watch <item-id>` so that I get a Telegram ping the moment the model thinks I have a >70% shot at the front page.
2. As a marketer monitoring competitor launches, I want to `/watch <domain>` so I get alerted within minutes whenever anyone posts a link from that domain to HN.
3. As a content creator, I want a daily digest that scores yesterday's HN posts so I can study what worked.
4. As a paid user, I want to set my own threshold so the bot does not spam me with low-confidence alerts.
5. As a paid user, I want to cancel my subscription via `/cancel` and have my watches drop to the free-tier limit instead of being deleted.

## MVP cuts

In MVP scope:
- HN poller, ingest, scorer, alert dispatcher, Telegram bot, Stripe webhook, daily digest, two paid tiers.

Out of MVP scope (deferred):
- Web dashboard. Telegram is the only UI.
- Multi-language support.
- Email alerts. Telegram only.
- Per-user trained model. Single global model.
- Reverse-engineered HN penalty detection. Treat all penalties as exogenous noise.

## Monetization model

- 7-day free trial of `pulse` for any user who runs `/upgrade`.
- $19/mo for `pulse`, $49/mo for `pulse-pro`. Annual plans at 2 months free.
- Stripe billing only. No PayPal or crypto for MVP.

## Success metrics

- 100 free signups in first 30 days.
- 8% free→paid conversion within 14 days of first watch.
- ≥0.70 ROC AUC on the 6h front-page prediction task, measured over a held-out 7-day window.
- Median alert latency (snapshot → Telegram message delivered) < 90 seconds.
- < 1 false-positive alert (>70% predicted, did not make front page) per user per week at default threshold.

## Acceptance criteria for stage-6 soak

These are the measurable thresholds `bin/test-completion.sh` checks daily:

1. **Poller liveness**: HN poller has fetched at least 1 batch of `/newstories` in the last 5 minutes (timestamp on most recent `items.first_seen_at`).
2. **Snapshot freshness**: At least 95% of tracked items (< 6h old) have a snapshot within the last 90 seconds.
3. **Scorer health**: Model has produced a probability for every snapshot in the last hour (no NULL `p_front_page_6h` values).
4. **Alert delivery**: Synthetic test watch fires an alert that lands in the test Telegram chat within 120 seconds of the matching snapshot — round-trip latency measured.
5. **Calibration drift**: Brier score on the last 7 days of predictions is ≤ 0.20 (above 0.25 means the model has decayed and needs retraining).

## Implementation alignment notes (2026-05-18)

- The alert dispatcher delivers threshold/acceleration/submission alerts through Telegram using persisted `users.telegram_user_id` mappings. Tests use fake senders only; production uses `TelegramAlertSender`.
- The poller tracks Hacker News top/front-page ranks by fetching `/topstories`, writing top-30 `item_snapshots.rank`, and marking `items.reached_front_page` / `reached_front_page_at` for outcome calibration.
- Canonical bot repository artifacts are `spec.md`, `brand.json`, and `PRODUCT.md`. Legacy `Spec.md` has been normalized to lowercase `spec.md`.

- The runtime image includes Bash because `bin/test-completion.sh` is an executable soak acceptance script with a Bash shebang.

- Synthetic alert latency acceptance requires at least one synthetic alert fixture in the prior 24h; an idle soak with no fixture is blocked/unknown, not failed delivery.
