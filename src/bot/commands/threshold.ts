import type { CommandContext, Context } from "grammy";
import { getUserByTelegramId, updateUserThreshold } from "../db.js";
import type { BotDeps } from "../deps.js";

export function parseThreshold(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  return n;
}

export function makeThresholdCommand(deps: BotDeps) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    const arg = (ctx.match ?? "").toString().trim();
    if (!arg) {
      await ctx.reply("Usage: /threshold <0-100>");
      return;
    }

    const value = parseThreshold(arg);
    if (value == null) {
      await ctx.reply("Threshold must be an integer between 0 and 100.");
      return;
    }

    const user = await getUserByTelegramId(deps.client, tgId);
    if (!user) {
      await ctx.reply("Run /start first to create your account.");
      return;
    }

    await updateUserThreshold(deps.client, user.id, value);

    if (user.tier === "free" && value < 80) {
      await ctx.reply(
        `Threshold set to ${value}%. Note: free tier still only fires at >80%. /upgrade to use lower thresholds.`,
      );
    } else {
      await ctx.reply(`Threshold set to ${value}%.`);
    }
  };
}
