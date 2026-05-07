import { describe, expect, it } from "vitest";
import { makeBotKit, makeCommandUpdate, makeFakeDb } from "./test-helpers.js";

describe("/me", () => {
  it("requires /start", async () => {
    const db = makeFakeDb();
    const kit = await makeBotKit({ client: db.client });

    await kit.send(makeCommandUpdate({ command: "me", fromId: 1 }));

    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("Run /start first");
  });

  it("renders tier, threshold, watches, and recent alerts", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u",
          telegram_user_id: 1,
          tier: "pulse",
          threshold_pct: 55,
          digest_opt_in: true,
          stripe_customer_id: "cus_X",
        },
      ],
      watches: [
        {
          id: "w-1",
          user_id: "u",
          watch_type: "domain",
          watch_value: "example.com",
          created_at: new Date("2026-01-01T00:00:00Z"),
        },
      ],
      alerts: [
        {
          id: "a-1",
          user_id: "u",
          item_id: 38765432,
          alert_type: "threshold",
          matched_at: new Date("2026-05-07T10:00:00Z"),
          delivered_at: new Date("2026-05-07T10:00:01Z"),
          payload: {},
          sent_at: new Date("2026-05-07T10:00:00Z"),
        },
      ],
    });
    const kit = await makeBotKit({ client: db.client });

    await kit.send(makeCommandUpdate({ command: "me", fromId: 1 }));

    const sent = kit.callsTo("sendMessage");
    const text = String(sent[0]!.payload.text);
    expect(text).toContain("Tier: pulse");
    expect(text).toContain("Threshold: 55%");
    expect(text).toContain("Digest: on");
    expect(text).toContain("Watches (1)");
    expect(text).toContain("domain: example.com");
    expect(text).toContain("threshold on 38765432");
  });

  it("handles users with no watches and no alerts", async () => {
    const db = makeFakeDb({
      users: [
        {
          id: "u",
          telegram_user_id: 1,
          tier: "free",
          threshold_pct: 60,
          digest_opt_in: false,
          stripe_customer_id: null,
        },
      ],
    });
    const kit = await makeBotKit({ client: db.client });

    await kit.send(makeCommandUpdate({ command: "me", fromId: 1 }));

    const sent = kit.callsTo("sendMessage");
    const text = String(sent[0]!.payload.text);
    expect(text).toContain("Watches (0)");
    expect(text).toContain("(none — use /watch to add one)");
    expect(text).toContain("(none yet)");
    expect(text).toContain("Digest: off");
  });
});
