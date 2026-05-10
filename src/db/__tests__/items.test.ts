import { describe, expect, it } from "vitest";
import {
  insertSnapshot,
  listItemsYoungerThan,
  recordServiceHeartbeat,
  upsertItem,
  type ItemsQueryClient,
} from "../items.js";

interface Call {
  text: string;
  params?: ReadonlyArray<unknown>;
}

function recordingClient(rows: unknown[] = []): {
  client: ItemsQueryClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client: ItemsQueryClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      calls.push({ text, params });
      return { rows: rows as T[] };
    },
  };
  return { client, calls };
}

describe("upsertItem", () => {
  it("issues an INSERT ... ON CONFLICT (id) DO UPDATE", async () => {
    const { client, calls } = recordingClient();
    const postedAt = new Date("2025-01-01T00:00:00Z");
    const firstSeenAt = new Date("2025-01-01T00:00:30Z");
    await upsertItem(client, {
      id: 555,
      by: "alice",
      title: "T",
      url: "https://example.com/x",
      domain: "example.com",
      posted_at: postedAt,
      first_seen_at: firstSeenAt,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/INSERT INTO items/i);
    expect(calls[0].text).toMatch(/ON CONFLICT \(id\) DO UPDATE/i);
    expect(calls[0].params).toEqual([
      555,
      "alice",
      "T",
      "https://example.com/x",
      "example.com",
      postedAt,
      firstSeenAt,
    ]);
  });
});

describe("insertSnapshot", () => {
  it("issues an INSERT into item_snapshots with all 9 columns", async () => {
    const { client, calls } = recordingClient();
    const takenAt = new Date("2025-01-01T00:01:00Z");
    await insertSnapshot(client, {
      item_id: 1,
      taken_at: takenAt,
      rank: 5,
      score: 10,
      comments: 3,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/INSERT INTO item_snapshots/i);
    expect(calls[0].params).toEqual([1, takenAt, 5, 10, 3, null, null, null, null]);
  });

  it("uses ON CONFLICT DO NOTHING for idempotency", async () => {
    const { client, calls } = recordingClient();
    await insertSnapshot(client, {
      item_id: 9,
      taken_at: new Date(),
      rank: null,
      score: null,
      comments: null,
    });
    expect(calls[0].text).toMatch(/ON CONFLICT \(item_id, taken_at\) DO NOTHING/i);
  });
});

describe("recordServiceHeartbeat", () => {
  it("upserts service heartbeat metadata", async () => {
    const { client, calls } = recordingClient();
    const checkedAt = new Date("2025-01-01T00:02:00Z");

    await recordServiceHeartbeat(client, {
      service: "hn_newstories_poller",
      checked_at: checkedAt,
      meta: { fresh_count: 500, new_count: 0 },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/INSERT INTO service_heartbeats/i);
    expect(calls[0].text).toMatch(/ON CONFLICT \(service\) DO UPDATE/i);
    expect(calls[0].params).toEqual([
      "hn_newstories_poller",
      checkedAt,
      JSON.stringify({ fresh_count: 500, new_count: 0 }),
    ]);
  });
});

describe("listItemsYoungerThan", () => {
  it("queries items with a parameterized hour interval", async () => {
    const ts = new Date("2025-01-01T00:00:00Z");
    const { client, calls } = recordingClient([{ id: 7, first_seen_at: ts }]);
    const rows = await listItemsYoungerThan(client, 6);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/INTERVAL '1 hour'/i);
    expect(calls[0].params).toEqual([6]);
    expect(rows).toEqual([{ id: 7, first_seen_at: ts }]);
  });

  it("coerces ISO string return values into Date", async () => {
    const { client } = recordingClient([
      { id: 1, first_seen_at: "2025-01-01T00:00:00Z" },
    ]);
    const rows = await listItemsYoungerThan(client, 1);
    expect(rows[0].first_seen_at).toBeInstanceOf(Date);
  });
});
