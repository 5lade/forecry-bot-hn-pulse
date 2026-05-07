import type { CommandContext, Context } from "grammy";
import { getUserByTelegramId } from "../db.js";
import type { BotDeps } from "../deps.js";

export function makeUpgradeCommand(deps: BotDeps) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    const user = await getUserByTelegramId(deps.client, tgId);
    if (!user) {
      await ctx.reply("Run /start first to create your account.");
      return;
    }

    if (user.tier !== "free") {
      await ctx.reply(
        `You're already on ${user.tier}. Use /cancel to manage your subscription.`,
      );
      return;
    }

    let session;
    try {
      session = await deps.billing.createCheckoutSession({
        telegramUserId: tgId,
        userId: user.id,
        publicUrl: deps.publicUrl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log?.(`[bot] upgrade checkout failed: ${msg}`);
      await ctx.reply(
        "Could not create a checkout session right now. Please try again later.",
      );
      return;
    }

    await ctx.reply(
      `Start your 7-day pulse trial here:\n${session.url}`,
      { link_preview_options: { is_disabled: true } },
    );
  };
}
