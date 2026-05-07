export interface ItemsQueryClient {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<{ rows: T[] }>;
}

export interface UpsertItemInput {
  id: number;
  by: string | null;
  title: string | null;
  url: string | null;
  domain: string | null;
  posted_at: Date;
  first_seen_at: Date;
}

export interface InsertSnapshotInput {
  item_id: number;
  taken_at: Date;
  rank: number | null;
  score: number | null;
  comments: number | null;
  score_velocity?: number | null;
  comment_velocity?: number | null;
  p_front_page_6h?: number | null;
  delta_p_5min?: number | null;
}

export interface ItemRow {
  id: number;
  first_seen_at: Date;
}

export interface SnapshotLookupRow {
  taken_at: Date;
  score: number | null;
  comments: number | null;
  p_front_page_6h: number | null;
}

export async function getMostRecentSnapshotBefore(
  client: ItemsQueryClient,
  itemId: number,
  beforeTs: Date,
): Promise<SnapshotLookupRow | null> {
  const res = await client.query<{
    taken_at: Date | string;
    score: number | null;
    comments: number | null;
    p_front_page_6h: number | string | null;
  }>(
    `SELECT taken_at, score, comments, p_front_page_6h
       FROM item_snapshots
      WHERE item_id = $1 AND taken_at < $2
      ORDER BY taken_at DESC
      LIMIT 1`,
    [itemId, beforeTs],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0]!;
  return {
    taken_at:
      row.taken_at instanceof Date ? row.taken_at : new Date(row.taken_at),
    score: row.score,
    comments: row.comments,
    p_front_page_6h:
      row.p_front_page_6h == null ? null : Number(row.p_front_page_6h),
  };
}

export async function getSnapshotAtOrBefore(
  client: ItemsQueryClient,
  itemId: number,
  cutoffTs: Date,
): Promise<SnapshotLookupRow | null> {
  const res = await client.query<{
    taken_at: Date | string;
    score: number | null;
    comments: number | null;
    p_front_page_6h: number | string | null;
  }>(
    `SELECT taken_at, score, comments, p_front_page_6h
       FROM item_snapshots
      WHERE item_id = $1 AND taken_at <= $2
      ORDER BY taken_at DESC
      LIMIT 1`,
    [itemId, cutoffTs],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0]!;
  return {
    taken_at:
      row.taken_at instanceof Date ? row.taken_at : new Date(row.taken_at),
    score: row.score,
    comments: row.comments,
    p_front_page_6h:
      row.p_front_page_6h == null ? null : Number(row.p_front_page_6h),
  };
}

export async function upsertItem(
  client: ItemsQueryClient,
  item: UpsertItemInput,
): Promise<void> {
  await client.query(
    `INSERT INTO items (id, by, title, url, domain, posted_at, first_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       by = COALESCE(EXCLUDED.by, items.by),
       title = COALESCE(EXCLUDED.title, items.title),
       url = COALESCE(EXCLUDED.url, items.url),
       domain = COALESCE(EXCLUDED.domain, items.domain)`,
    [
      item.id,
      item.by,
      item.title,
      item.url,
      item.domain,
      item.posted_at,
      item.first_seen_at,
    ],
  );
}

export async function insertSnapshot(
  client: ItemsQueryClient,
  snap: InsertSnapshotInput,
): Promise<void> {
  await client.query(
    `INSERT INTO item_snapshots (
       item_id, taken_at, rank, score, comments,
       score_velocity, comment_velocity, p_front_page_6h, delta_p_5min
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (item_id, taken_at) DO NOTHING`,
    [
      snap.item_id,
      snap.taken_at,
      snap.rank,
      snap.score,
      snap.comments,
      snap.score_velocity ?? null,
      snap.comment_velocity ?? null,
      snap.p_front_page_6h ?? null,
      snap.delta_p_5min ?? null,
    ],
  );
}

export async function listItemsYoungerThan(
  client: ItemsQueryClient,
  hours: number,
): Promise<ItemRow[]> {
  const res = await client.query<{ id: number; first_seen_at: Date | string }>(
    `SELECT id, first_seen_at
       FROM items
      WHERE first_seen_at > NOW() - (INTERVAL '1 hour' * $1)`,
    [hours],
  );
  return res.rows.map((r) => ({
    id: r.id,
    first_seen_at:
      r.first_seen_at instanceof Date
        ? r.first_seen_at
        : new Date(r.first_seen_at),
  }));
}
