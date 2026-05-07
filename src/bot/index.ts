import { Bot, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { makeCancelCommand } from "./commands/cancel.js";
import { makeDigestCommand } from "./commands/digest.js";
import { makeMeCommand } from "./commands/me.js";
import { makeStartCommand } from "./commands/start.js";
import { makeThresholdCommand } from "./commands/threshold.js";
import {
  UNWATCH_CALLBACK_PREFIX,
  makeUnwatchCallback,
  makeUnwatchCommand,
} from "./commands/unwatch.js";
import { makeUpgradeCommand } from "./commands/upgrade.js";
import { makeWatchCommand } from "./commands/watch.js";
import type { BotDeps } from "./deps.js";

export interface CreateBotOptions {
  token: string;
  deps: BotDeps;
  botInfo?: UserFromGetMe;
}

export function createBot(opts: CreateBotOptions): Bot<Context> {
  const bot = new Bot<Context>(
    opts.token,
    opts.botInfo ? { botInfo: opts.botInfo } : undefined,
  );
  registerCommands(bot, opts.deps);
  return bot;
}

export function registerCommands(bot: Bot<Context>, deps: BotDeps): void {
  bot.command("start", makeStartCommand(deps));
  bot.command("watch", makeWatchCommand(deps));
  bot.command("unwatch", makeUnwatchCommand(deps));
  bot.command("threshold", makeThresholdCommand(deps));
  bot.command("digest", makeDigestCommand(deps));
  bot.command("me", makeMeCommand(deps));
  bot.command("upgrade", makeUpgradeCommand(deps));
  bot.command("cancel", makeCancelCommand(deps));

  bot.callbackQuery(
    new RegExp(`^${UNWATCH_CALLBACK_PREFIX}`),
    makeUnwatchCallback(deps),
  );

  bot.catch((err) => {
    const msg = err.error instanceof Error ? err.error.message : String(err.error);
    deps.log?.(`[bot] handler error: ${msg}`);
  });
}

export interface StartBotOptions {
  token: string;
  deps: BotDeps;
  webhookEnabled?: boolean;
  log?: (msg: string) => void;
}

export interface BotHandle {
  bot: Bot<Context>;
  stop: () => Promise<void>;
  mode: "polling" | "webhook";
}

/**
 * Start the bot. By default it long-polls (MVP per Spec.md). When
 * FEATURE_TG_WEBHOOK is set the bot is initialized but not started — the
 * caller is expected to register webhookCallback() on the Express server.
 */
export async function startBot(opts: StartBotOptions): Promise<BotHandle> {
  const bot = createBot({ token: opts.token, deps: opts.deps });
  const log = opts.log ?? opts.deps.log ?? (() => {});

  const webhookEnabled =
    opts.webhookEnabled ?? process.env.FEATURE_TG_WEBHOOK === "1";

  if (webhookEnabled) {
    await bot.init();
    log(`[bot] webhook mode (FEATURE_TG_WEBHOOK=1) — caller wires HTTP route`);
    return {
      bot,
      mode: "webhook",
      async stop() {
        // No long-poll loop; nothing to stop. Webhook is owned by the server.
      },
    };
  }

  // Long-poll for MVP. bot.start() resolves when the loop exits.
  const startPromise = bot.start({
    onStart: (info) => log(`[bot] long-polling as @${info.username}`),
  });
  // Surface fatal long-poll errors to the configured logger.
  void startPromise.catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[bot] long-poll exited: ${msg}`);
  });

  return {
    bot,
    mode: "polling",
    async stop() {
      await bot.stop();
    },
  };
}
