import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  type MigrationFile,
  type MigrationRunner,
  discoverMigrations,
  migrate,
  pendingMigrations,
} from "./migrate.js";

class MockRunner implements MigrationRunner {
  public ensureCalls = 0;
  public applied: string[] = [];
  constructor(private alreadyApplied: Set<string> = new Set()) {}

  async ensureMigrationsTable(): Promise<void> {
    this.ensureCalls += 1;
  }
  async listApplied(): Promise<Set<string>> {
    return new Set(this.alreadyApplied);
  }
  async applyMigration(file: MigrationFile, sql: string): Promise<void> {
    if (!sql || sql.length === 0) {
      throw new Error(`empty SQL for ${file.name}`);
    }
    this.alreadyApplied.add(file.name);
    this.applied.push(file.name);
  }
}

async function makeMigrationsDir(
  files: Record<string, string>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "hnpulse-mig-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, name), body, "utf8");
  }
  return dir;
}

describe("discoverMigrations", () => {
  it("returns only NNNN_*.sql files in lexicographic order", async () => {
    const dir = await makeMigrationsDir({
      "0002_two.sql": "SELECT 2;",
      "0001_one.sql": "SELECT 1;",
      "README.md": "ignored",
      "not_numbered.sql": "ignored",
    });
    try {
      const found = await discoverMigrations(dir);
      expect(found.map((f) => f.name)).toEqual([
        "0001_one.sql",
        "0002_two.sql",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("pendingMigrations", () => {
  it("returns migrations not yet applied", () => {
    const discovered: MigrationFile[] = [
      { name: "0001_a.sql", fullPath: "/x/0001_a.sql" },
      { name: "0002_b.sql", fullPath: "/x/0002_b.sql" },
      { name: "0003_c.sql", fullPath: "/x/0003_c.sql" },
    ];
    const applied = new Set(["0001_a.sql"]);
    const pending = pendingMigrations(discovered, applied);
    expect(pending.map((m) => m.name)).toEqual(["0002_b.sql", "0003_c.sql"]);
  });

  it("returns empty when everything is applied", () => {
    const discovered: MigrationFile[] = [
      { name: "0001_a.sql", fullPath: "/x/0001_a.sql" },
    ];
    const applied = new Set(["0001_a.sql"]);
    expect(pendingMigrations(discovered, applied)).toEqual([]);
  });
});

describe("migrate (with mock runner)", () => {
  it("applies pending migrations and skips already-applied ones", async () => {
    const dir = await makeMigrationsDir({
      "0001_init.sql": "SELECT 1;",
      "0002_more.sql": "SELECT 2;",
    });
    try {
      const runner = new MockRunner(new Set(["0001_init.sql"]));
      const result = await migrate({ migrationsDir: dir, runner });
      expect(runner.ensureCalls).toBe(1);
      expect(result.applied).toEqual(["0002_more.sql"]);
      expect(result.skipped).toEqual(["0001_init.sql"]);
      expect(runner.applied).toEqual(["0002_more.sql"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when all migrations are already applied", async () => {
    const dir = await makeMigrationsDir({
      "0001_init.sql": "SELECT 1;",
    });
    try {
      const runner = new MockRunner(new Set(["0001_init.sql"]));
      const result = await migrate({ migrationsDir: dir, runner });
      expect(result.applied).toEqual([]);
      expect(result.skipped).toEqual(["0001_init.sql"]);
      expect(runner.applied).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies migrations in lexicographic order", async () => {
    const dir = await makeMigrationsDir({
      "0003_c.sql": "SELECT 3;",
      "0001_a.sql": "SELECT 1;",
      "0002_b.sql": "SELECT 2;",
    });
    try {
      const runner = new MockRunner();
      const result = await migrate({ migrationsDir: dir, runner });
      expect(result.applied).toEqual([
        "0001_a.sql",
        "0002_b.sql",
        "0003_c.sql",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
