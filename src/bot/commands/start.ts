import type { CommandContext, Context } from "grammy";
import { upsertUserByTelegramId } from "../db.js";
import type { BotDeps } from "../deps.js";

export function makeStartCommand(deps: BotDeps) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    const user = await upsertUserByTelegramId(deps.client, tgId, deps.generateId);

    await ctx.reply(
      [
        "Welcome to HN Pulse — front-page predictions for Hacker News.",
        "",
        `Tier: ${user.tier} · Threshold: ${user.threshold_pct}% · Digest: ${user.digest_opt_in ? "on" : "off"}`,
        "",
        "Commands:",
        "  /watch <item-id | domain | @submitter>",
        "  /unwatch — list watches with remove buttons",
        "  /threshold <0-100>",
        "  /digest — toggle daily digest",
        "  /me — show your account",
        "  /upgrade — go paid (more watches, lower threshold)",
        "  /cancel — manage subscription",
      ].join("\n"),
    );
  };
}
