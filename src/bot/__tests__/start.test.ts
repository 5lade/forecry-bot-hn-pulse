import { describe, expect, it } from "vitest";
import {
  makeBotKit,
  makeCommandUpdate,
  makeFakeDb,
  makeIdGenerator,
} from "./test-helpers.js";

describe("/start", () => {
  it("creates a user row and replies with the welcome text", async () => {
    const db = makeFakeDb();
    const kit = await makeBotKit({
      client: db.client,
      deps: { generateId: makeIdGenerator("user") },
    });

    await kit.send(makeCommandUpdate({ command: "start", fromId: 100 }));

    expect(db.users).toHaveLength(1);
    expect(db.users[0]!.telegram_user_id).toBe(100);
    expect(db.users[0]!.tier).toBe("free");

    const sent = kit.callsTo("sendMessage");
    expect(sent).toHaveLength(1);
    expect(String(sent[0]!.payload.text)).toContain("Welcome to HN Pulse");
    expect(String(sent[0]!.payload.text)).toContain("Tier: free");
  });

  it("is idempotent: running /start twice does not create a second user", async () => {
    const db = makeFakeDb();
    const kit = await makeBotKit({
      client: db.client,
      deps: { generateId: makeIdGenerator("user") },
    });

    await kit.send(makeCommandUpdate({ command: "start", fromId: 200 }));
    await kit.send(makeCommandUpdate({ command: "start", fromId: 200 }));

    expect(db.users).toHaveLength(1);
    expect(db.users[0]!.telegram_user_id).toBe(200);
    expect(kit.callsTo("sendMessage")).toHaveLength(2);
  });
});
