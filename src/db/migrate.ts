import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { closePool, getPool, withClient } from "./client.js";

export interface MigrationFile {
  name: string;
  fullPath: string;
}

const MIGRATION_FILE_RE = /^\d{4}_.+\.sql$/;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "db",
  "migrations",
);

export async function discoverMigrations(
  dir: string,
): Promise<MigrationFile[]> {
  const entries = await readdir(dir);
  return entries
    .filter((name) => MIGRATION_FILE_RE.test(name))
    .sort()
    .map((name) => ({ name, fullPath: path.join(dir, name) }));
}

export function pendingMigrations(
  discovered: ReadonlyArray<MigrationFile>,
  applied: ReadonlySet<string>,
): MigrationFile[] {
  return discovered.filter((m) => !applied.has(m.name));
}

export interface MigrationRunner {
  ensureMigrationsTable(): Promise<void>;
  listApplied(): Promise<Set<string>>;
  applyMigration(file: MigrationFile, sql: string): Promise<void>;
}

export class PgMigrationRunner implements MigrationRunner {
  constructor(private readonly client: pg.PoolClient) {}

  async ensureMigrationsTable(): Promise<void> {
    await this.client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  async listApplied(): Promise<Set<string>> {
    const res = await this.client.query<{ name: string }>(
      "SELECT name FROM schema_migrations",
    );
    return new Set(res.rows.map((r) => r.name));
  }

  async applyMigration(file: MigrationFile, sql: string): Promise<void> {
    await this.client.query("BEGIN");
    try {
      await this.client.query(sql);
      await this.client.query(
        "INSERT INTO schema_migrations (name) VALUES ($1)",
        [file.name],
      );
      await this.client.query("COMMIT");
    } catch (err) {
      await this.client.query("ROLLBACK");
      throw err;
    }
  }
}

export interface MigrateOptions {
  migrationsDir?: string;
  runner?: MigrationRunner;
  log?: (msg: string) => void;
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(
  opts: MigrateOptions = {},
): Promise<MigrateResult> {
  const dir = opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const log = opts.log ?? (() => {});

  const run = async (runner: MigrationRunner): Promise<MigrateResult> => {
    await runner.ensureMigrationsTable();
    const applied = await runner.listApplied();
    const discovered = await discoverMigrations(dir);
    const pending = pendingMigrations(discovered, applied);

    const skipped = discovered
      .filter((m) => applied.has(m.name))
      .map((m) => m.name);
    const appliedNames: string[] = [];

    for (const file of pending) {
      const sql = await readFile(file.fullPath, "utf8");
      log(`applying ${file.name}`);
      await runner.applyMigration(file, sql);
      appliedNames.push(file.name);
    }

    return { applied: appliedNames, skipped };
  };

  if (opts.runner) {
    return run(opts.runner);
  }

  return withClient(async (client) => run(new PgMigrationRunner(client)));
}

async function cli(): Promise<void> {
  const log = (msg: string) => process.stdout.write(`[migrate] ${msg}\n`);
  try {
    const result = await migrate({ log });
    log(
      `done. applied=${result.applied.length} skipped=${result.skipped.length}`,
    );
  } finally {
    await closePool();
  }
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  cli().catch((err: unknown) => {
    process.stderr.write(`[migrate] failed: ${String(err)}\n`);
    process.exitCode = 1;
    closePool().catch(() => {});
  });
}

export { getPool };
