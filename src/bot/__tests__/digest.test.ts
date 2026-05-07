import { describe, expect, it } from "vitest";
import { makeBotKit, makeCommandUpdate, makeFakeDb } from "./test-helpers.js";

describe("/digest", () => {
  it("toggles digest_opt_in from on to off and back", async () => {
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

    await kit.send(makeCommandUpdate({ command: "digest", fromId: 1 }));
    expect(db.users[0]!.digest_opt_in).toBe(false);
    let sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("OFF");

    await kit.send(makeCommandUpdate({ command: "digest", fromId: 1 }));
    expect(db.users[0]!.digest_opt_in).toBe(true);
    sent = kit.callsTo("sendMessage");
    expect(String(sent[1]!.payload.text)).toContain("ON");
  });

  it("requires /start", async () => {
    const db = makeFakeDb();
    const kit = await makeBotKit({ client: db.client });

    await kit.send(makeCommandUpdate({ command: "digest", fromId: 99 }));

    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("Run /start first");
  });
});
