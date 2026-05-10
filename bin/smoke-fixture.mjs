#!/usr/bin/env node
// bin/smoke-fixture.mjs
//
// Smoke harness for the stage-6 soak probes (hn-pulse-p1-009).
//
// We do not have docker or a system Postgres in the bot-factory smoke
// environment, so this runner uses @electric-sql/pglite — a real-Postgres
// build (WASM) that runs in-process. It applies every migration in
// db/migrations/, including the new 0004_soak_views.sql, then seeds either
// a healthy fixture or a fixture that intentionally violates exactly one
// criterion. It then runs the same view queries that bin/test-completion.sh
// runs and emits matching PASS/FAIL output.
//
// Usage:
//   node bin/smoke-fixture.mjs healthy
//   node bin/smoke-fixture.mjs break-1   # criterion 1 only fails
//   node bin/smoke-fixture.mjs break-2
//   node bin/smoke-fixture.mjs break-3
//   node bin/smoke-fixture.mjs break-4
//   node bin/smoke-fixture.mjs break-5
//
// Exit code: 0 when the *expected* PASS/FAIL pattern for the scenario
// matches, else 1. (Healthy expects all PASS; break-N expects only
// criterion N to FAIL.)

import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO = resolve(__dirname, '..');
const MIGRATIONS_DIR = join(REPO, 'db', 'migrations');

const SCENARIO = process.argv[2];
const VALID = ['healthy', 'break-1', 'break-2', 'break-3', 'break-4', 'break-5'];
if (!VALID.includes(SCENARIO)) {
  console.error(`Usage: node bin/smoke-fixture.mjs <${VALID.join('|')}>`);
  process.exit(2);
}

async function applyMigrations(db) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    await db.exec(sql);
  }
}

// --- fixture builders ---------------------------------------------------

async function seedUser(db) {
  const id = randomUUID();
  await db.query(
    `INSERT INTO users (id, telegram_user_id, tier) VALUES ($1::uuid, $2::bigint, 'pulse');`,
    [id, 100001]
  );
  return id;
}

// Seed a healthy world: one fresh poller hit, 20 tracked items each with a
// snapshot in the last 60s, no NULL probabilities, synthetic alerts with
// fast latency, and a 7-day calibration history with Brier ~0.05.
async function seedHealthy(db, userId) {
  await db.query(
    `INSERT INTO service_heartbeats (service, checked_at, meta)
     VALUES ('hn_newstories_poller', NOW() - INTERVAL '30 seconds', '{"fresh_count": 500, "new_count": 0}'::jsonb);`
  );

  // Criterion 1+2+3: tracked items with fresh snapshots
  for (let i = 1; i <= 20; i++) {
    await db.query(
      `INSERT INTO items (id, by, title, url, domain, posted_at, first_seen_at, reached_front_page)
       VALUES ($1::int, 'alice', 'item ' || $1::text, 'https://x.test/' || $1::text, 'x.test',
               NOW() - INTERVAL '30 seconds', NOW() - INTERVAL '30 seconds', NULL);`,
      [i]
    );
    await db.query(
      `INSERT INTO item_snapshots (item_id, taken_at, rank, score, comments, score_velocity, comment_velocity, p_front_page_6h, delta_p_5min)
       VALUES ($1::int, NOW() - INTERVAL '30 seconds', NULL, 5, 1, 0.5, 0.1, 0.42, 0.01);`,
      [i]
    );
  }

  // Criterion 4: synthetic alerts with low latency
  for (let i = 0; i < 50; i++) {
    const matchedAgoSec = 60 + i * 10;
    const latencySec = 30 + (i % 20); // up to 49s, p95 well below 120s
    await db.query(
      `INSERT INTO alerts (id, user_id, item_id, alert_type, matched_at, delivered_at, payload)
       VALUES ($1::uuid, $2::uuid, 1, 'synthetic',
               NOW() - INTERVAL '1 second' * $3::int,
               NOW() - INTERVAL '1 second' * ($3::int - $4::int),
               '{}'::jsonb);`,
      [randomUUID(), userId, matchedAgoSec, latencySec]
    );
  }

  // Criterion 5: 7-day calibration history.
  // 100 items posted >6h ago, with a snapshot 6 days ago, well-calibrated
  // probabilities (Brier ~0.05).
  for (let i = 100; i < 200; i++) {
    const reached = i % 5 === 0; // 20% reach front page
    const p = reached ? 0.78 : 0.18;
    await db.query(
      `INSERT INTO items (id, by, title, url, domain, posted_at, first_seen_at, reached_front_page)
       VALUES ($1::int, 'bob', 'old ' || $1::text, 'https://x.test/' || $1::text, 'x.test',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '7 days', $2::boolean);`,
      [i, reached]
    );
    await db.query(
      `INSERT INTO item_snapshots (item_id, taken_at, rank, score, comments, score_velocity, comment_velocity, p_front_page_6h, delta_p_5min)
       VALUES ($1::int, NOW() - INTERVAL '6 days', NULL, 10, 3, 1.0, 0.2, $2::numeric, 0.0);`,
      [i, p]
    );
  }

  // PGlite can be slow in constrained CI/local Docker. Reseat the liveness
  // and freshness timestamps after all fixture rows are loaded so unrelated
  // seed duration does not trip the sub-90s/sub-300s acceptance probes.
  await db.query(
    `UPDATE service_heartbeats
        SET checked_at = NOW() - INTERVAL '30 seconds'
      WHERE service = 'hn_newstories_poller';`
  );
  await db.query(
    `UPDATE items
        SET posted_at = NOW() - INTERVAL '30 seconds',
            first_seen_at = NOW() - INTERVAL '30 seconds'
      WHERE id BETWEEN 1 AND 20;`
  );
  await db.query(
    `UPDATE item_snapshots
        SET taken_at = NOW() - INTERVAL '30 seconds'
      WHERE item_id BETWEEN 1 AND 20;`
  );
}

// --- breakers: each one breaks exactly one criterion ---

async function breakCriterion1(db) {
  // Poller dead: move the newstories heartbeat outside the liveness window.
  // Snapshots stay fresh (so criterion 2 passes) and alerts/calibration
  // history is untouched.
  await db.query(
    `UPDATE service_heartbeats
        SET checked_at = NOW() - INTERVAL '600 seconds'
      WHERE service = 'hn_newstories_poller';`
  );
}

async function breakCriterion2(db) {
  // Snapshot freshness: drop snapshots for half the tracked items so we
  // dip below 95%. Tracked items 1..20 are <6h old; remove fresh snapshots
  // for 11..20 (so freshness = 50%).
  await db.query(
    `DELETE FROM item_snapshots WHERE item_id BETWEEN 11 AND 20;`
  );
}

async function breakCriterion3(db) {
  // Insert a snapshot in the last hour with NULL p_front_page_6h.
  await db.query(
    `INSERT INTO item_snapshots (item_id, taken_at, rank, score, comments, score_velocity, comment_velocity, p_front_page_6h, delta_p_5min)
     VALUES (1, NOW() - INTERVAL '5 minutes', NULL, 5, 1, 0.5, 0.1, NULL, 0.01);`
  );
}

async function breakCriterion4(db, userId) {
  // Push two synthetic alerts with very high latency so p95 jumps over 120s.
  for (let i = 0; i < 5; i++) {
    await db.query(
      `INSERT INTO alerts (id, user_id, item_id, alert_type, matched_at, delivered_at, payload)
       VALUES ($1::uuid, $2::uuid, 1, 'synthetic',
               NOW() - INTERVAL '10 minutes',
               NOW() - INTERVAL '10 minutes' + INTERVAL '500 seconds',
               '{}'::jsonb);`,
      [randomUUID(), userId]
    );
  }
}

async function breakCriterion5(db) {
  // Wipe well-calibrated history and replace with a confidently wrong set
  // — predict 0.95 for items that did NOT reach the front page.
  await db.query(`DELETE FROM item_snapshots WHERE item_id BETWEEN 100 AND 199;`);
  await db.query(`DELETE FROM items WHERE id BETWEEN 100 AND 199;`);
  for (let i = 300; i < 400; i++) {
    await db.query(
      `INSERT INTO items (id, by, title, url, domain, posted_at, first_seen_at, reached_front_page)
       VALUES ($1::int, 'bob', 'old ' || $1::text, 'https://x.test/' || $1::text, 'x.test',
               NOW() - INTERVAL '7 days', NOW() - INTERVAL '7 days', FALSE);`,
      [i]
    );
    await db.query(
      `INSERT INTO item_snapshots (item_id, taken_at, rank, score, comments, score_velocity, comment_velocity, p_front_page_6h, delta_p_5min)
       VALUES ($1::int, NOW() - INTERVAL '6 days', NULL, 10, 3, 1.0, 0.2, 0.95, 0.0);`,
      [i]
    );
  }
}

// --- probe runner: runs the same SELECTs the bash script runs ----------

async function scalar(db, sql) {
  const r = await db.query(sql);
  if (!r.rows.length) return null;
  const v = Object.values(r.rows[0])[0];
  return v === null ? null : String(v);
}

function num(s) { return s === null ? NaN : Number(s); }

async function runProbes(db) {
  console.log('Running acceptance tests for hn-pulse...');
  let pass = 0, fail = 0;
  const results = [];

  // Criterion 1
  console.log('[criterion-1] Poller liveness (successful newstories heartbeat <300s old)');
  const lag = await scalar(db, 'SELECT lag_seconds FROM v_poller_lag;');
  if (lag !== null && num(lag) < 300) {
    console.log(`  PASS (lag=${lag}s)`); pass++; results.push('PASS');
  } else {
    console.log(`  FAIL (lag=${lag ?? 'NULL'}s)`); fail++; results.push('FAIL');
  }

  // Criterion 2
  console.log('[criterion-2] Snapshot freshness (>=95% of tracked items have snapshot <90s)');
  const pct = await scalar(db, 'SELECT freshness_pct FROM v_snapshot_freshness;');
  if (pct !== null && num(pct) >= 95) {
    console.log(`  PASS (${pct}%)`); pass++; results.push('PASS');
  } else {
    console.log(`  FAIL (${pct ?? 'NULL'}%)`); fail++; results.push('FAIL');
  }

  // Criterion 3
  console.log('[criterion-3] Scorer health (no NULL p_front_page_6h in last hour)');
  const nulls = await scalar(db, 'SELECT null_count FROM v_scorer_null_count_1h;');
  if (nulls === '0') {
    console.log('  PASS (null_count=0)'); pass++; results.push('PASS');
  } else {
    console.log(`  FAIL (null_count=${nulls ?? 'NULL'})`); fail++; results.push('FAIL');
  }

  // Criterion 4
  console.log('[criterion-4] Alert latency (p95 round-trip <120s in last 24h)');
  const p95 = await scalar(db, 'SELECT p95_seconds FROM v_alert_latency;');
  if (p95 !== null && num(p95) < 120) {
    console.log(`  PASS (p95=${p95}s)`); pass++; results.push('PASS');
  } else {
    console.log(`  FAIL (p95=${p95 ?? 'NULL'}s)`); fail++; results.push('FAIL');
  }

  // Criterion 5
  console.log('[criterion-5] Calibration drift (Brier score 7d <=0.20)');
  const brier = await scalar(db, 'SELECT brier_score FROM v_calibration_brier_7d;');
  if (brier !== null && num(brier) <= 0.20) {
    console.log(`  PASS (Brier=${brier})`); pass++; results.push('PASS');
  } else {
    console.log(`  FAIL (Brier=${brier ?? 'NULL'})`); fail++; results.push('FAIL');
  }

  console.log('');
  console.log(`Result: ${pass} pass, ${fail} fail`);
  return results;
}

// --- main --------------------------------------------------------------

const db = new PGlite();
try {
  await applyMigrations(db);
  const userId = await seedUser(db);
  await seedHealthy(db, userId);

  switch (SCENARIO) {
    case 'healthy': break;
    case 'break-1': await breakCriterion1(db); break;
    case 'break-2': await breakCriterion2(db); break;
    case 'break-3': await breakCriterion3(db); break;
    case 'break-4': await breakCriterion4(db, userId); break;
    case 'break-5': await breakCriterion5(db); break;
  }

  const results = await runProbes(db);

  // Verify the scenario produced the expected PASS/FAIL pattern.
  const expected = ['PASS', 'PASS', 'PASS', 'PASS', 'PASS'];
  if (SCENARIO.startsWith('break-')) {
    const n = parseInt(SCENARIO.split('-')[1], 10);
    expected[n - 1] = 'FAIL';
  }
  const ok = results.every((r, i) => r === expected[i]);
  if (!ok) {
    console.error(`\n[smoke] expected ${JSON.stringify(expected)} got ${JSON.stringify(results)}`);
    process.exit(1);
  }
  console.log(`[smoke] scenario ${SCENARIO} matched expected pattern.`);
  process.exit(0);
} finally {
  await db.close().catch(() => {});
}
