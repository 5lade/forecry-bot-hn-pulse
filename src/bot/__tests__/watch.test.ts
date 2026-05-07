import { describe, expect, it } from "vitest";
import {
  makeBotKit,
  makeCommandUpdate,
  makeFakeDb,
  makeIdGenerator,
  type FakeUser,
} from "./test-helpers.js";

function freeUser(overrides: Partial<FakeUser> = {}): FakeUser {
  return {
    id: "user-free",
    telegram_user_id: 42,
    tier: "free",
    threshold_pct: 60,
    digest_opt_in: true,
    stripe_customer_id: null,
    ...overrides,
  };
}

describe("/watch", () => {
  it("rejects with usage hint when no argument provided", async () => {
    const db = makeFakeDb({ users: [freeUser()] });
    const kit = await makeBotKit({ client: db.client });

    await kit.send(makeCommandUpdate({ command: "watch", fromId: 42 }));

    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("Usage: /watch");
    expect(db.watches).toHaveLength(0);
  });

  it("rejects unparseable target with a clear error", async () => {
    const db = makeFakeDb({ users: [freeUser()] });
    const kit = await makeBotKit({ client: db.client });

    await kit.send(
      makeCommandUpdate({ command: "watch", arg: "not a target", fromId: 42 }),
    );

    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("Could not add watch");
    expect(db.watches).toHaveLength(0);
  });

  it("requires /start before adding a watch", async () => {
    const db = makeFakeDb();
    const kit = await makeBotKit({ client: db.client });

    await kit.send(
      makeCommandUpdate({ command: "watch", arg: "@pg", fromId: 999 }),
    );

    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("Run /start first");
  });

  it("adds an item watch for a free user under the limit", async () => {
    const db = makeFakeDb({ users: [freeUser()] });
    const kit = await makeBotKit({
      client: db.client,
      deps: { generateId: makeIdGenerator("watch") },
    });

    await kit.send(
      makeCommandUpdate({ command: "watch", arg: "38765432", fromId: 42 }),
    );

    expect(db.watches).toHaveLength(1);
    expect(db.watches[0]!.watch_type).toBe("item");
    expect(db.watches[0]!.watch_value).toBe("38765432");
    expect(db.watches[0]!.user_id).toBe("user-free");
  });

  it("enforces free-tier 2-watch limit with a clear error", async () => {
    const db = makeFakeDb({
      users: [freeUser()],
      watches: [
        {
          id: "w1",
          user_id: "user-free",
          watch_type: "domain",
          watch_value: "a.com",
          created_at: new Date(),
        },
        {
          id: "w2",
          user_id: "user-free",
          watch_type: "domain",
          watch_value: "b.com",
          created_at: new Date(),
        },
      ],
    });
    const kit = await makeBotKit({ client: db.client });

    await kit.send(
      makeCommandUpdate({ command: "watch", arg: "c.com", fromId: 42 }),
    );

    expect(db.watches).toHaveLength(2);
    const sent = kit.callsTo("sendMessage");
    const text = String(sent[0]!.payload.text);
    expect(text).toContain("Free tier is limited to 2 watches");
    expect(text).toContain("/upgrade");
  });

  it("paid tier ignores the free-tier limit", async () => {
    const paid = freeUser({ id: "user-paid", telegram_user_id: 77, tier: "pulse" });
    const watches = Array.from({ length: 10 }, (_, i) => ({
      id: `w${i}`,
      user_id: "user-paid",
      watch_type: "domain",
      watch_value: `d${i}.com`,
      created_at: new Date(),
    }));
    const db = makeFakeDb({ users: [paid], watches });
    const kit = await makeBotKit({
      client: db.client,
      deps: { generateId: makeIdGenerator("w-paid") },
    });

    await kit.send(
      makeCommandUpdate({ command: "watch", arg: "extra.com", fromId: 77 }),
    );

    expect(db.watches).toHaveLength(11);
  });
});
