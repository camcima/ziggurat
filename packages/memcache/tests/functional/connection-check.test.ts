import { describe, it, expect, afterAll } from "vitest";
import memjs from "memjs";

const MEMCACHE_URL = process.env.MEMCACHE_URL;

describe("Functional test prerequisites", () => {
  it("should have MEMCACHE_URL environment variable set", () => {
    expect(MEMCACHE_URL).toBeDefined();
    expect(MEMCACHE_URL).not.toBe("");
  });

  it("should connect to Memcached successfully", async () => {
    expect(MEMCACHE_URL).toBeDefined();
    const client = memjs.Client.create(MEMCACHE_URL);
    try {
      // memjs doesn't have ping, but set/get works as a connectivity check
      await client.set("__connection_check__", "ok", { expires: 10 });
      const result = await client.get("__connection_check__");
      expect(result.value).not.toBeNull();
      expect(result.value!.toString()).toBe("ok");
    } finally {
      client.close();
    }
  });
});
