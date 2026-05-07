import type { CommandContext, Context } from "grammy";
import {
  getUserByTelegramId,
  listRecentAlerts,
  listUserWatches,
} from "../db.js";
import type { BotDeps } from "../deps.js";

function fmtAlertLine(a: { item_id: number; alert_type: string; matched_at: Date | null }): string {
  const when = a.matched_at ? a.matched_at.toISOString() : "pending";
  return `  · ${a.alert_type} on ${a.item_id} (${when})`;
}

export function makeMeCommand(deps: BotDeps) {
  return async (ctx: CommandContext<Context>): Promise<void> => {
    const tgId = ctx.from?.id;
    if (!tgId) return;

    const user = await getUserByTelegramId(deps.client, tgId);
    if (!user) {
      await ctx.reply("Run /start first to create your account.");
      return;
    }

    const [watches, alerts] = await Promise.all([
      listUserWatches(deps.client, user.id),
      listRecentAlerts(deps.client, user.id, 5),
    ]);

    const watchLines =
      watches.length === 0
        ? "  (none — use /watch to add one)"
        : watches
            .map((w) => `  · ${w.watch_type}: ${w.watch_value}`)
            .join("\n");

    const alertLines =
      alerts.length === 0
        ? "  (none yet)"
        : alerts.map(fmtAlertLine).join("\n");

    await ctx.reply(
      [
        `Tier: ${user.tier}`,
        `Threshold: ${user.threshold_pct}%`,
        `Digest: ${user.digest_opt_in ? "on" : "off"}`,
        "",
        `Watches (${watches.length}):`,
        watchLines,
        "",
        "Recent alerts:",
        alertLines,
      ].join("\n"),
    );
  };
}
