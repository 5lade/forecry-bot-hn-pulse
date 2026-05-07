# forecry-bot-hn-pulse

Real-time Hacker News front-page predictor. Forecry Bot Factory production.

## Build

Worker agents pick the highest-priority `[ ]` ticket in `TODO.md`, implement, test, commit, and push to `main`. Tickets are in rule8 fence format.

## Run

```bash
docker build -t forecry-bot-hn-pulse .
docker run -d --name forecry-bot-hn-pulse \
  -e DATABASE_URL=... \
  -e TG_BOT_TOKEN=... \
  -e STRIPE_SECRET_KEY=... \
  -e STRIPE_WEBHOOK_SECRET=... \
  ghcr.io/5lade/forecry-bot-hn-pulse:latest
```

## Tests

`bin/test-completion.sh` is run daily by the soak monitor. It probes Postgres for poller liveness, snapshot freshness, scorer health, alert latency, and calibration drift. See [acceptance-tests.md](./acceptance-tests.md).
