import { Bot, type Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { BotQueryClient, UserRow } from "../db.js";
import { registerCommands } from "../index.js";
import type { BotDeps } from "../deps.js";
import { StubBillingClient, type BillingClient } from "../stripe.js";

/**
 * Test harness around grammy's Bot — a "test helper" wrapper that mirrors the
 * patterns recommended in the grammY docs (transformer-based API stubbing,
 * manual update injection via `bot.handleUpdate`).
 */
export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

export interface BotTestKit {
  bot: Bot;
  apiCalls: ApiCall[];
  callsTo(method: string): ApiCall[];
  send(update: Update): Promise<void>;
}

const FAKE_BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  can_manage_bots: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as unknown as UserFromGetMe;

export interface MakeBotKitOptions {
  deps?: Partial<BotDeps>;
  client: BotQueryClient;
  billing?: BillingClient;
  publicUrl?: string;
}

export async function makeBotKit(opts: MakeBotKitOptions): Promise<BotTestKit> {
  const apiCalls: ApiCall[] = [];

  const bot = new Bot("123:fake-token-for-tests", {
    botInfo: FAKE_BOT_INFO,
  });

  bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({
      method,
      payload: payload as Record<string, unknown>,
    });
    if (method === "answerCallbackQuery") {
      return { ok: true, result: true } as never;
    }
    if (method === "sendMessage") {
      return {
        ok: true,
        result: {
          message_id: apiCalls.length,
          date: Math.floor(Date.now() / 1000),
          chat: (payload as { chat_id: number }).chat_id
            ? { id: (payload as { chat_id: number }).chat_id, type: "private" }
            : { id: 0, type: "private" },
          text: (payload as { text?: string }).text ?? "",
        },
      } as never;
    }
    return { ok: true, result: true } as never;
  });

  const deps: BotDeps = {
    client: opts.client,
    billing: opts.billing ?? new StubBillingClient(opts.publicUrl ?? "https://example.com"),
    publicUrl: opts.publicUrl ?? "https://example.com",
    ...opts.deps,
  };

  registerCommands(bot, deps);
  await bot.init();

  return {
    bot,
    apiCalls,
    callsTo: (method) => apiCalls.filter((c) => c.method === method),
    async send(update) {
      await bot.handleUpdate(update);
    },
  };
}

let nextUpdateId = 1000;
let nextMessageId = 1;

export interface MakeCommandUpdateOptions {
  command: string;
  arg?: string;
  fromId?: number;
  chatId?: number;
}

export function makeCommandUpdate(opts: MakeCommandUpdateOptions): Update {
  const fromId = opts.fromId ?? 42;
  const chatId = opts.chatId ?? fromId;
  const text = opts.arg
    ? `/${opts.command} ${opts.arg}`
    : `/${opts.command}`;
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextMessageId++,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "Test" },
      from: {
        id: fromId,
        is_bot: false,
        first_name: "Test",
        language_code: "en",
      },
      text,
      entities: [
        {
          type: "bot_command",
          offset: 0,
          length: opts.command.length + 1,
        },
      ],
    },
  } as Update;
}

export function makeCallbackQueryUpdate(opts: {
  data: string;
  fromId?: number;
  chatId?: number;
  messageId?: number;
}): Update {
  const fromId = opts.fromId ?? 42;
  const chatId = opts.chatId ?? fromId;
  const messageId = opts.messageId ?? 1;
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId),
      from: {
        id: fromId,
        is_bot: false,
        first_name: "Test",
        language_code: "en",
      },
      chat_instance: "test-chat-instance",
      data: opts.data,
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: "private", first_name: "Test" },
        from: FAKE_BOT_INFO,
        text: "previous bot message",
      },
    },
  } as Update;
}

/**
 * In-memory fake of BotQueryClient. Supports only the queries the bot
 * commands actually issue, but does so in a way that exercises the same
 * SQL strings the production code emits.
 */
export interface FakeUser extends UserRow {}

export interface FakeWatch {
  id: string;
  user_id: string;
  watch_type: string;
  watch_value: string;
  created_at: Date;
}

export interface FakeAlert {
  id: string;
  user_id: string;
  item_id: number;
  alert_type: string;
  matched_at: Date | null;
  delivered_at: Date | null;
  payload: unknown;
  sent_at: Date;
}

export interface FakeDb {
  users: FakeUser[];
  watches: FakeWatch[];
  alerts: FakeAlert[];
  client: BotQueryClient;
  callLog: Array<{ text: string; params?: ReadonlyArray<unknown> }>;
}

export function makeFakeDb(seed: Partial<Omit<FakeDb, "client" | "callLog">> = {}): FakeDb {
  const users: FakeUser[] = [...(seed.users ?? [])];
  const watches: FakeWatch[] = [...(seed.watches ?? [])];
  const alerts: FakeAlert[] = [...(seed.alerts ?? [])];
  const callLog: FakeDb["callLog"] = [];

  let idCounter = 0;
  const nextId = (): string => `fake-id-${++idCounter}`;

  const client: BotQueryClient = {
    async query<T extends Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<{ rows: T[] }> {
      callLog.push({ text, params });
      const sql = text.trim();

      // INSERT INTO users ... ON CONFLICT (telegram_user_id) DO UPDATE ... RETURNING
      if (/^INSERT INTO users/i.test(sql)) {
        const id = String(params![0]);
        const tgId = Number(params![1]);
        const existing = users.find((u) => Number(u.telegram_user_id) === tgId);
        if (existing) {
          return { rows: [existing as unknown as T] };
        }
        const created: FakeUser = {
          id,
          telegram_user_id: tgId,
          tier: "free",
          threshold_pct: 60,
          digest_opt_in: true,
          stripe_customer_id: null,
        };
        users.push(created);
        return { rows: [created as unknown as T] };
      }

      if (/^SELECT[\s\S]*FROM users\b/i.test(sql)) {
        const tgId = Number(params![0]);
        const u = users.find((x) => Number(x.telegram_user_id) === tgId);
        return { rows: u ? [u as unknown as T] : [] };
      }

      if (/^SELECT COUNT\(\*\)[\s\S]*FROM watches/i.test(sql)) {
        const userId = String(params![0]);
        const count = watches.filter((w) => w.user_id === userId).length;
        return { rows: [{ count } as unknown as T] };
      }

      if (/^SELECT[\s\S]*FROM watches/i.test(sql)) {
        const userId = String(params![0]);
        const rows = watches
          .filter((w) => w.user_id === userId)
          .map((w) => ({ ...w }));
        return { rows: rows as unknown as T[] };
      }

      if (/^INSERT INTO watches/i.test(sql)) {
        const watch: FakeWatch = {
          id: String(params![0]),
          user_id: String(params![1]),
          watch_type: String(params![2]),
          watch_value: String(params![3]),
          created_at: new Date(),
        };
        watches.push(watch);
        return { rows: [watch as unknown as T] };
      }

      if (/^DELETE FROM watches/i.test(sql)) {
        const watchId = String(params![0]);
        const userId = String(params![1]);
        const idx = watches.findIndex(
          (w) => w.id === watchId && w.user_id === userId,
        );
        if (idx === -1) return { rows: [] };
        const [removed] = watches.splice(idx, 1);
        return { rows: [{ id: removed!.id } as unknown as T] };
      }

      if (/^UPDATE users SET threshold_pct/i.test(sql)) {
        const userId = String(params![0]);
        const value = Number(params![1]);
        const u = users.find((x) => x.id === userId);
        if (u) u.threshold_pct = value;
        return { rows: [] };
      }

      if (/^UPDATE users SET digest_opt_in/i.test(sql)) {
        const userId = String(params![0]);
        const u = users.find((x) => x.id === userId);
        if (!u) return { rows: [] };
        u.digest_opt_in = !u.digest_opt_in;
        return { rows: [{ digest_opt_in: u.digest_opt_in } as unknown as T] };
      }

      if (/^UPDATE users SET stripe_customer_id/i.test(sql)) {
        const userId = String(params![0]);
        const customerId = String(params![1]);
        const u = users.find((x) => x.id === userId);
        if (u) u.stripe_customer_id = customerId;
        return { rows: [] };
      }

      if (/^SELECT[\s\S]*FROM alerts/i.test(sql)) {
        const userId = String(params![0]);
        const limit = Number(params![1] ?? 5);
        const rows = alerts
          .filter((a) => a.user_id === userId)
          .sort((a, b) => b.sent_at.getTime() - a.sent_at.getTime())
          .slice(0, limit);
        return { rows: rows as unknown as T[] };
      }

      throw new Error(`FakeDb: unhandled SQL: ${sql.slice(0, 80)}`);
    },
  };

  return { users, watches, alerts, client, callLog };
}

export function makeIdGenerator(prefix = "gen"): () => string {
  let i = 0;
  return () => `${prefix}-${++i}`;
}
