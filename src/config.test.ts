import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const VALID_ENV = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/hnpulse",
  TG_BOT_TOKEN: "123456:ABCDEF",
  STRIPE_SECRET_KEY: "sk_test_123",
  STRIPE_WEBHOOK_SECRET: "whsec_123",
  PUBLIC_URL: "https://hn-pulse.example.com",
  NODE_ENV: "test",
  LOG_LEVEL: "info",
} as const;

const REQUIRED_KEYS = [
  "DATABASE_URL",
  "TG_BOT_TOKEN",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "PUBLIC_URL",
  "NODE_ENV",
  "LOG_LEVEL",
] as const;

describe("loadConfig", () => {
  it("parses cleanly when all required env vars are present", () => {
    const config = loadConfig({ ...VALID_ENV });
    expect(config).toEqual(VALID_ENV);
  });

  it("throws a ConfigError when called", () => {
    expect(() => loadConfig({})).toThrowError(ConfigError);
  });

  for (const key of REQUIRED_KEYS) {
    it(`throws a descriptive error when ${key} is missing`, () => {
      const env: Record<string, string> = { ...VALID_ENV };
      delete env[key];
      let caught: unknown;
      try {
        loadConfig(env);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const message = (caught as Error).message;
      expect(message).toContain(key);
      expect(message).toMatch(/required|Required/);
    });
  }

  it("collects all missing keys in a single error message", () => {
    let caught: unknown;
    try {
      loadConfig({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as Error).message;
    for (const key of REQUIRED_KEYS) {
      expect(message).toContain(key);
    }
  });
});
