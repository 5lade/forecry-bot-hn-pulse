import { describe, expect, it } from "vitest";
import { UNWATCH_CALLBACK_PREFIX } from "../commands/unwatch.js";
import {
  makeBotKit,
  makeCallbackQueryUpdate,
  makeCommandUpdate,
  makeFakeDb,
} from "./test-helpers.js";

describe("/unwatch", () => {
  it("tells empty users they have nothing to remove", async () => {
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

    await kit.send(makeCommandUpdate({ command: "unwatch", fromId: 1 }));

    const sent = kit.callsTo("sendMessage");
    expect(String(sent[0]!.payload.text)).toContain("no active watches");
  });

  it("lists watches with inline buttons keyed by watch id", async () => {
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
      watches: [
        {
          id: "w-abc",
          user_id: "u",
          watch_type: "domain",
          watch_value: "a.com",
          created_at: new Date(),
        },
        {
          id: "w-xyz",
          user_id: "u",
          watch_type: "submitter",
          watch_value: "pg",
          created_at: new Date(),
        },
      ],
    });
    const kit = await makeBotKit({ client: db.client });

    await kit.send(makeCommandUpdate({ command: "unwatch", fromId: 1 }));

    const sent = kit.callsTo("sendMessage");
    expect(sent).toHaveLength(1);
    const markup = sent[0]!.payload.reply_markup as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    };
    expect(markup.inline_keyboard).toHaveLength(2);
    expect(markup.inline_keyboard[0]![0]!.callback_data).toBe(
      `${UNWATCH_CALLBACK_PREFIX}w-abc`,
    );
    expect(markup.inline_keyboard[1]![0]!.callback_data).toBe(
      `${UNWATCH_CALLBACK_PREFIX}w-xyz`,
    );
  });

  it("removes a watch when the inline button is pressed", async () => {
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
      watches: [
        {
          id: "w-abc",
          user_id: "u",
          watch_type: "domain",
          watch_value: "a.com",
          created_at: new Date(),
        },
      ],
    });
    const kit = await makeBotKit({ client: db.client });

    await kit.send(
      makeCallbackQueryUpdate({
        data: `${UNWATCH_CALLBACK_PREFIX}w-abc`,
        fromId: 1,
      }),
    );

    expect(db.watches).toHaveLength(0);
    const ack = kit.callsTo("answerCallbackQuery");
    expect(ack).toHaveLength(1);
    expect(String(ack[0]!.payload.text)).toBe("Watch removed.");
  });

  it("acknowledges gracefully when the watch is already gone", async () => {
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
      makeCallbackQueryUpdate({
        data: `${UNWATCH_CALLBACK_PREFIX}w-missing`,
        fromId: 1,
      }),
    );

    const ack = kit.callsTo("answerCallbackQuery");
    expect(ack).toHaveLength(1);
    expect(String(ack[0]!.payload.text)).toContain("not found");
  });
});
