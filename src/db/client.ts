import pg from "pg";

const { Pool } = pg;

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;
export type QueryResult<T extends pg.QueryResultRow = pg.QueryResultRow> =
  pg.QueryResult<T>;

let pool: pg.Pool | null = null;

export interface CreatePoolOptions {
  connectionString?: string;
  max?: number;
}

export function createPool(opts: CreatePoolOptions = {}): pg.Pool {
  const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  return new Pool({
    connectionString,
    max: opts.max ?? 10,
  });
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: ReadonlyArray<unknown>,
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[] | undefined);
}

export async function withClient<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withClient(async (client) => {
    await client.query("BEGIN");
    try {
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  });
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
