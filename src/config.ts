import "dotenv/config";
import { z } from "zod";

const REQUIRED_KEYS = [
  "DATABASE_URL",
  "TG_BOT_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "PUBLIC_URL",
  "NODE_ENV",
  "LOG_LEVEL",
] as const;

export const ConfigSchema = z.object({
  DATABASE_URL: z
    .string({ required_error: "DATABASE_URL is required" })
    .url("DATABASE_URL must be a valid URL"),
  TG_BOT_TOKEN: z
    .string({ required_error: "TG_BOT_TOKEN is required" })
    .min(1, "TG_BOT_TOKEN must not be empty"),
  STRIPE_SECRET_KEY: z
    .string({ required_error: "STRIPE_SECRET_KEY is required" })
    .min(1, "STRIPE_SECRET_KEY must not be empty"),
  STRIPE_WEBHOOK_SECRET: z
    .string({ required_error: "STRIPE_WEBHOOK_SECRET is required" })
    .min(1, "STRIPE_WEBHOOK_SECRET must not be empty"),
  PUBLIC_URL: z
    .string({ required_error: "PUBLIC_URL is required" })
    .url("PUBLIC_URL must be a valid URL"),
  NODE_ENV: z.enum(["development", "test", "production"], {
    required_error: "NODE_ENV is required",
    invalid_type_error: "NODE_ENV must be development|test|production",
  }),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"], {
    required_error: "LOG_LEVEL is required",
    invalid_type_error:
      "LOG_LEVEL must be one of fatal|error|warn|info|debug|trace",
  }),
});

const SoakConfigSchema = ConfigSchema.extend({
  TG_BOT_TOKEN: z.string().optional().default(""),
  STRIPE_SECRET_KEY: z.string().optional().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default(""),
});

export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function isSoakEnv(source: NodeJS.ProcessEnv = process.env): boolean {
  return source.FORECRY_BOT_SOAK === "true" || source.FORECRY_BOT_MODE === "dry-run";
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const candidate: Record<string, unknown> = {};
  for (const key of REQUIRED_KEYS) {
    const value = source[key];
    if (value !== undefined) {
      candidate[key] = value;
    }
  }

  const soak = isSoakEnv(source);
  const parsed = (soak ? SoakConfigSchema : ConfigSchema).safeParse(candidate);
  if (parsed.success) {
    if (soak && parsed.data.STRIPE_SECRET_KEY.startsWith("sk_live_")) {
      throw new ConfigError(
        "Invalid environment configuration:\n  - STRIPE_SECRET_KEY: live Stripe keys are not allowed in soak/dry-run mode",
      );
    }
    return parsed.data;
  }

  const issues = parsed.error.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    return `${key}: ${issue.message}`;
  });
  throw new ConfigError(
    `Invalid environment configuration:\n${issues
      .map((line) => `  - ${line}`)
      .join("\n")}`,
  );
}

export function redactConfig(config: Config): Record<string, string> {
  const redactUrl = (url: string): string => {
    try {
      const u = new URL(url);
      if (u.password) u.password = "***";
      if (u.username) u.username = "***";
      return u.toString();
    } catch {
      return "***";
    }
  };
  return {
    NODE_ENV: config.NODE_ENV,
    LOG_LEVEL: config.LOG_LEVEL,
    PUBLIC_URL: config.PUBLIC_URL,
    DATABASE_URL: redactUrl(config.DATABASE_URL),
    TG_BOT_TOKEN: "***",
    STRIPE_SECRET_KEY: "***",
    STRIPE_WEBHOOK_SECRET: "***",
  };
}
