import type { CommandContext, Context } from "grammy";
import { getUserByTelegramId } from "../db.js";
import type { BotDeps } from "../deps.js";

export function makeCancelCommand(deps: BotDeps) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    const user = await getUserByTelegramId(deps.client, tgId);
    if (!user) {
      await ctx.reply("Run /start first to create your account.");
      return;
    }

    if (!user.stripe_customer_id) {
      await ctx.reply(
        "You're on the free tier — nothing to cancel. /upgrade to start a trial.",
      );
      return;
    }

    let portal;
    try {
      portal = await deps.billing.createBillingPortalSession({
        customerId: user.stripe_customer_id,
        publicUrl: deps.publicUrl,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.log?.(`[bot] cancel portal failed: ${msg}`);
      await ctx.reply(
        "Could not open the billing portal right now. Please try again later.",
      );
      return;
    }

    await ctx.reply(
      `Manage your subscription here:\n${portal.url}`,
      { link_preview_options: { is_disabled: true } },
    );
  };
}
