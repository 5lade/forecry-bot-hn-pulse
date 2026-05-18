# HN Pulse — Product Brief

## One-liner

HN Pulse predicts whether a fresh Hacker News submission will reach the front page within 6 hours and sends Telegram alerts when watched posts, domains, or submitters cross user-defined probability thresholds.

## Customer

- Indie hackers and founders launching on Hacker News.
- Growth marketers and competitive-intel operators monitoring HN momentum.
- Content creators studying what makes HN posts break through.

## Core value

HN launch outcomes are disproportionately shaped by the first 30 minutes. HN Pulse watches `/newest`, snapshots early velocity, scores front-page probability, and tells users when intervention is still timely.

## MVP surface

- Telegram commands: `/watch`, `/unwatch`, `/threshold`, `/digest`, `/me`, `/upgrade`, `/cancel`.
- HN poller and snapshot store.
- Logistic front-page probability scorer.
- Threshold, acceleration, and submitted-item alerts.
- Stripe subscription state.
- Daily digest and calibration metrics.
- Pulse Pro webhook/API-key delivery.

## Plans

- Free: up to 2 watches, >80% alerts only, no digest.
- Pulse ($19/mo): 25 watches, configurable thresholds, daily digest, acceleration alerts.
- Pulse Pro ($49/mo): unlimited watches, webhook delivery, weekly calibration report, API key.

## Soak acceptance

`bin/test-completion.sh` is the stage-6 gate. It checks poller liveness, snapshot freshness, scorer completeness, synthetic Telegram alert delivery, and calibration drift.

## Canonical artifacts

- `spec.md` — technical/product specification.
- `brand.json` — positioning, audience, channels, plans, tone.
- `PRODUCT.md` — product brief and packaging summary.
