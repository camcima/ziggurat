import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Redis from "ioredis";
import { RedisAdapter } from "../../src/redis-adapter.js";
import { runAdapterContractTests } from "../../../core/tests/contract/adapter-contract.test.js";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const TEST_PREFIX = `ziggurat-test:${Date.now()}:`;

let redis: Redis;

beforeAll(() => {
  redis = new Redis(REDIS_URL);
});

afterAll(async () => {
  // Clean up all test keys
  const keys = await redis.keys(`${TEST_PREFIX}*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  await redis.quit();
});

// Run the shared contract test suite against a REAL Redis instance
runAdapterContractTests(
  "RedisAdapter (real Redis)",
  () => new RedisAdapter({ client: redis, prefix: TEST_PREFIX }),
);

describe("RedisAdapter functional tests (real Redis)", () => {
  let adapter: RedisAdapter;

  beforeEach(async () => {
    adapter = new RedisAdapter({ client: redis, prefix: TEST_PREFIX });
    await adapter.clear();
  });

  describe("JSON serialization round-trip", () => {
    it("should correctly store and retrieve a string", async () => {
      await adapter.set("str", "hello world");
      const result = await adapter.get<string>("str");
      expect(result!.value).toBe("hello world");
      expect(result!.expiresAt).toBeNull();
    });

    it("should correctly store and retrieve a number", async () => {
      await adapter.set("num", 3.14);
      const result = await adapter.get<number>("num");
      expect(result!.value).toBe(3.14);
    });

    it("should correctly store and retrieve a nested object", async () => {
      const obj = { users: [{ id: 1, name: "Alice" }], meta: { page: 1 } };
      await adapter.set("obj", obj);
      const result = await adapter.get<typeof obj>("obj");
      expect(result!.value).toEqual(obj);
    });

    it("should correctly store and retrieve null value", async () => {
      await adapter.set("nil", null);
      const result = await adapter.get<null>("nil");
      expect(result!.value).toBeNull();
    });

    it("should correctly store and retrieve boolean values", async () => {
      await adapter.set("t", true);
      await adapter.set("f", false);
      expect((await adapter.get<boolean>("t"))!.value).toBe(true);
      expect((await adapter.get<boolean>("f"))!.value).toBe(false);
    });
  });

  describe("TTL with real Redis expiry", () => {
    it("should expire entries via Redis PSETEX", async () => {
      await adapter.set("ttl-key", "value", 100);
      const before = await adapter.get<string>("ttl-key");
      expect(before!.value).toBe("value");

      // Wait for Redis to expire the key
      await new Promise((resolve) => setTimeout(resolve, 200));
      const after = await adapter.get<string>("ttl-key");
      expect(after).toBeNull();
    });

    it("should persist entries without TTL", async () => {
      await adapter.set("no-ttl", "forever");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await adapter.get<string>("no-ttl");
      expect(result!.value).toBe("forever");
    });
  });

  describe("prefix isolation", () => {
    it("should not see keys from a different prefix", async () => {
      const adapter2 = new RedisAdapter({
        client: redis,
        prefix: `other-prefix:${Date.now()}:`,
      });

      await adapter.set("shared-key", "from-adapter1");
      await adapter2.set("shared-key", "from-adapter2");

      expect((await adapter.get<string>("shared-key"))!.value).toBe(
        "from-adapter1",
      );
      expect((await adapter2.get<string>("shared-key"))!.value).toBe(
        "from-adapter2",
      );

      // Cleanup adapter2
      await adapter2.clear();
    });

    it("should only clear keys with its own prefix", async () => {
      const prefix2 = `other-clear:${Date.now()}:`;
      const adapter2 = new RedisAdapter({ client: redis, prefix: prefix2 });

      await adapter.set("k1", "v1");
      await adapter2.set("k2", "v2");

      await adapter.clear();

      expect(await adapter.get("k1")).toBeNull();
      expect((await adapter2.get<string>("k2"))!.value).toBe("v2");

      await adapter2.clear();
    });
  });

  describe("concurrent operations", () => {
    it("should handle many concurrent set/get operations", async () => {
      const count = 50;
      const setPromises = Array.from({ length: count }, (_, i) =>
        adapter.set(`concurrent:${i}`, { index: i }),
      );
      await Promise.all(setPromises);

      const getPromises = Array.from({ length: count }, (_, i) =>
        adapter.get<{ index: number }>(`concurrent:${i}`),
      );
      const results = await Promise.all(getPromises);

      for (let i = 0; i < count; i++) {
        expect(results[i]!.value).toEqual({ index: i });
      }
    });
  });
});
