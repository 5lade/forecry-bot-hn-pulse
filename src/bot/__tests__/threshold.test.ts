import { describe, expect, it } from "vitest";
import { parseThreshold } from "../commands/threshold.js";
import { makeBotKit, makeCommandUpdate, makeFakeDb } from "./test-helpers.js";

describe("parseThreshold", () => {
  it("accepts integers in [0, 100]", () => {
    expect(parseThreshold("0")).toBe(0);
    expect(parseThreshold("60")).toBe(60);
    expect(parseThreshold("100")).toBe(100);
  });

  it("rejects out-of-range, decimals, and non-numeric input", () => {
    expect(parseThreshold("-1")).toBeNull();
    expect(parseThreshold("101")).toBeNull();
    expect(parseThreshold("70.5")).toBeNull();
    expect(parseThreshold("abc")).toBeNull();
    expect(parseThreshold("")).toBeNull();
  });
});

describe("/threshold", () => {
  it("usage hint when no argument", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u",
          telegram_user_id: 1,
          tier: "pulse",
          threshold_pct: 60,
          digest_opt_in: true,
          stripe_customer_id: null,
        },
      ],
    });
    const kit = await makeBotKit({ client: db.client });

    await kit.send(makeCommandUpdate({ command: "threshold", fromId: 1 }));

    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("Usage: /threshold");
  });

  it("rejects out-of-range values", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u",
          telegram_user_id: 1,
          tier: "pulse",
          threshold_pct: 60,
          digest_opt_in: true,
          stripe_customer_id: null,
        },
      ],
    });
    const kit = await makeBotKit({ client: db.client });

    await kit.send(
      makeCommandUpdate({ command: "threshold", arg: "150", fromId: 1 }),
    );

    expect(db.users[0]!.threshold_pct).toBe(60);
    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("between 0 and 100");
  });

  it("updates threshold for paid users", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u",
          telegram_user_id: 1,
          tier: "pulse",
          threshold_pct: 60,
          digest_opt_in: true,
          stripe_customer_id: null,
        },
      ],
    });
    const kit = await makeBotKit({ client: db.client });

    await kit.send(
      makeCommandUpdate({ command: "threshold", arg: "45", fromId: 1 }),
    );

    expect(db.users[0]!.threshold_pct).toBe(45);
    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toBe("Threshold set to 45%.");
  });

  it("warns free users that their effective threshold is still capped", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u",
          telegram_user_id: 1,
          tier: "free",
          threshold_pct: 60,
          digest_opt_in: true,
          stripe_customer_id: null,
        },
      ],
    });
    const kit = await makeBotKit({ client: db.client });

    await kit.send(
      makeCommandUpdate({ command: "threshold", arg: "30", fromId: 1 }),
    );

    expect(db.users[0]!.threshold_pct).toBe(30);
    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("free tier still only fires at >80%");
  });
});
