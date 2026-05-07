# HN Pulse

> Real-time Hacker News front-page predictor — get pinged on Telegram the moment your launch has a real shot.

A Forecry Bot Factory production. developer-tools intelligence.

## What it does

HN Pulse polls Hacker News `/newstories` every 30 seconds, scores every new submission's probability of reaching the front page within 6 hours using early upvote velocity, comment cadence, posting hour, domain reputation and title features, and pushes Telegram alerts to subscribers when the items they care about cross their thresholds. It also tracks competitor domains and specific submitters, and emits a daily digest with hits, misses, and model calibration.

## Why someone pays for it

Indie hackers and founders pay for launch-day intelligence: HN Pulse spots momentum in the first 30 minutes — when ~35% of front-page outcome is decided — so they can intervene at the right time instead of refreshing `/newest` for hours.

## Quickstart

```bash
docker build -t forecry-bot-hn-pulse .
docker run -d --name hn-pulse -e API_KEY=... forecry-bot-hn-pulse
```

## Spec

See [Spec.md](./Spec.md).

## Acceptance tests

See [acceptance-tests.md](./acceptance-tests.md). Run via `bin/test-completion.sh`.
