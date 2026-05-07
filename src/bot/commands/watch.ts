import type { CommandContext, Context } from "grammy";
import {
  countUserWatches,
  FREE_TIER_WATCH_LIMIT,
  getUserByTelegramId,
  insertWatch,
} from "../db.js";
import type { BotDeps } from "../deps.js";
import { parseWatchTarget, WatchParseError } from "../parse-watch.js";

export function makeWatchCommand(deps: BotDeps) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    const arg = (ctx.match ?? "").toString().trim();
    if (!arg) {
      await ctx.reply(
        "Usage: /watch <item-id | domain | @submitter>\nExamples: /watch 38765432, /watch example.com, /watch @pg",
      );
      return;
    }

    let target;
    try {
      target = parseWatchTarget(arg);
    } catch (err) {
      const msg = err instanceof WatchParseError ? err.message : String(err);
      await ctx.reply(`Could not add watch: ${msg}`);
      return;
    }

    const user = await getUserByTelegramId(deps.client, tgId);
    if (!user) {
      await ctx.reply("Run /start first to create your account.");
      return;
    }

    if (user.tier === "free") {
      const current = await countUserWatches(deps.client, user.id);
      if (current >= FREE_TIER_WATCH_LIMIT) {
        await ctx.reply(
          `Free tier is limited to ${FREE_TIER_WATCH_LIMIT} watches. Run /upgrade to add more, or /unwatch to free a slot.`,
        );
        return;
      }
    }

    const watch = await insertWatch(deps.client, {
      userId: user.id,
      watchType: target.watch_type,
      watchValue: target.watch_value,
      generateId: deps.generateId,
    });

    await ctx.reply(
      `Watching ${watch.watch_type} \`${watch.watch_value}\`. You'll be pinged when it crosses your threshold.`,
      { parse_mode: "Markdown" },
    );
  };
}
