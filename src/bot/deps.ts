import type { BotQueryClient } from "./db.js";
import type { BillingClient } from "./stripe.js";

export interface BotDeps {
  client: BotQueryClient;
  billing: BillingClient;
  publicUrl: string;
  generateId?: () => string;
  log?: (msg: string) => void;
}
