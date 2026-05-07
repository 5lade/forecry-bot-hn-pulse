import { describe, expect, it } from "vitest";
import type { ItemsQueryClient } from "../items.js";
import {
  listMatchingWatches,
  listWatchesByDomain,
  listWatchesByItem,
  listWatchesBySubmitter,
} from "../watches.js";

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

describe("listWatchesByItem", () => {
  it("filters by watch_type='item' and stringifies the item id", async () => {
    const { client, calls } = recordingClient([]);
    await listWatchesByItem(client, 42);
    expect(calls[0]?.text).toMatch(/watch_type\s*=\s*'item'/i);
    expect(calls[0]?.params).toEqual(["42"]);
  });

  it("normalizes user_threshold_pct returned as a string from pg", async () => {
    const { client } = recordingClient([
      {
        id: "w-1",
        user_id: "u-1",
        watch_type: "item",
        watch_value: "42",
        user_tier: "pulse",
        user_threshold_pct: "65",
      },
    ]);
    const out = await listWatchesByItem(client, 42);
    expect(out[0]?.user_threshold_pct).toBe(65);
    expect(typeof out[0]?.user_threshold_pct).toBe("number");
  });
});

describe("listWatchesByDomain", () => {
  it("filters by watch_type='domain'", async () => {
    const { client, calls } = recordingClient([]);
    await listWatchesByDomain(client, "example.com");
    expect(calls[0]?.text).toMatch(/watch_type\s*=\s*'domain'/i);
    expect(calls[0]?.params).toEqual(["example.com"]);
  });
});

describe("listWatchesBySubmitter", () => {
  it("filters by watch_type='submitter'", async () => {
    const { client, calls } = recordingClient([]);
    await listWatchesBySubmitter(client, "alice");
    expect(calls[0]?.text).toMatch(/watch_type\s*=\s*'submitter'/i);
    expect(calls[0]?.params).toEqual(["alice"]);
  });
});

describe("listMatchingWatches", () => {
  it("queries item, domain, and submitter when all three are present", async () => {
    const { client, calls } = recordingClient([]);
    await listMatchingWatches(client, {
      itemId: 42,
      domain: "example.com",
      submitter: "alice",
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.text).toMatch(/watch_type\s*=\s*'item'/i);
    expect(calls[1]?.text).toMatch(/watch_type\s*=\s*'domain'/i);
    expect(calls[2]?.text).toMatch(/watch_type\s*=\s*'submitter'/i);
  });

  it("skips domain and submitter queries when those fields are null", async () => {
    const { client, calls } = recordingClient([]);
    await listMatchingWatches(client, {
      itemId: 42,
      domain: null,
      submitter: null,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toMatch(/watch_type\s*=\s*'item'/i);
  });
});
