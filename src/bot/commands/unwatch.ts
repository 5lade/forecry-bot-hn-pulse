import type { CallbackQueryContext, CommandContext, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { deleteWatchById, getUserByTelegramId, listUserWatches } from "../db.js";
import type { BotDeps } from "../deps.js";

export const UNWATCH_CALLBACK_PREFIX = "unwatch:";

export function makeUnwatchCommand(deps: BotDeps) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    const user = await getUserByTelegramId(deps.client, tgId);
    if (!user) {
      await ctx.reply("Run /start first to create your account.");
      return;
    }

    const watches = await listUserWatches(deps.client, user.id);
    if (watches.length === 0) {
      await ctx.reply("You have no active watches. Use /watch to add one.");
      return;
    }

    const keyboard = new InlineKeyboard();
    watches.forEach((w, i) => {
      if (i > 0) keyboard.row();
      keyboard.text(
        `❌ ${w.watch_type}: ${w.watch_value}`,
        `${UNWATCH_CALLBACK_PREFIX}${w.id}`,
      );
    });

    await ctx.reply("Select a watch to remove:", {
      reply_markup: keyboard,
    });
  };
}

export function makeUnwatchCallback(deps: BotDeps) {
  return async (ctx: CallbackQueryContext<Context>): Promise<void> => {
    const tgId = ctx.from?.id;
    const data = ctx.callbackQuery.data ?? "";
    if (!tgId || !data.startsWith(UNWATCH_CALLBACK_PREFIX)) return;

    const watchId = data.slice(UNWATCH_CALLBACK_PREFIX.length);

    const user = await getUserByTelegramId(deps.client, tgId);
    if (!user) {
      await ctx.answerCallbackQuery({ text: "Run /start first." });
      return;
    }

    const removed = await deleteWatchById(deps.client, {
      watchId,
      userId: user.id,
    });

    if (removed) {
      await ctx.answerCallbackQuery({ text: "Watch removed." });
    } else {
      await ctx.answerCallbackQuery({
        text: "Watch not found (already removed?).",
      });
    }
  };
}
