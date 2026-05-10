import { describe, expect, it } from "vitest";
import { createPool } from "./client.js";

describe("createPool", () => {
  it("registers an idle-client error handler", async () => {
    const pool = createPool({
      connectionString: "postgres://user:pass@localhost:5432/hnpulse",
    });
    try {
      expect(pool.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      await pool.end();
    }
  });
});
