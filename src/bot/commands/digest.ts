import type { CommandContext, Context } from "grammy";
import { getUserByTelegramId, toggleUserDigest } from "../db.js";
import type { BotDeps } from "../deps.js";

export function makeDigestCommand(deps: BotDeps) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    const user = await getUserByTelegramId(deps.client, tgId);
    if (!user) {
      await ctx.reply("Run /start first to create your account.");
      return;
    }

    const newValue = await toggleUserDigest(deps.client, user.id);
    await ctx.reply(
      newValue
        ? "Daily digest is now ON. You'll get yesterday's calibration at 09:00 UTC."
        : "Daily digest is now OFF.",
    );
  };
}
