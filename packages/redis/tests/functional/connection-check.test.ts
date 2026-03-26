import { describe, it, expect, afterAll } from "vitest";
import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL;

describe("Functional test prerequisites", () => {
  it("should have REDIS_URL environment variable set", () => {
    expect(REDIS_URL).toBeDefined();
    expect(REDIS_URL).not.toBe("");
  });

  it("should connect to Redis successfully", async () => {
    expect(REDIS_URL).toBeDefined();
    const redis = new Redis(REDIS_URL!);
    try {
      const pong = await redis.ping();
      expect(pong).toBe("PONG");
    } finally {
      await redis.quit();
    }
  });
});
