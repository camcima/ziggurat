import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
import Redis from "ioredis";
import { RedisAdapter } from "../../src/redis-adapter.js";
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const TEST_PREFIX = `ziggurat-multilayer:${Date.now()}:`;

let redis: Redis;

beforeAll(() => {
  redis = new Redis(REDIS_URL);
});

afterAll(async () => {
  const keys = await redis.keys(`${TEST_PREFIX}*`);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
  await redis.quit();
});

describe("Multi-layer: MemoryAdapter (L1) + RedisAdapter (L2) — real Redis", () => {
  let l1: MemoryAdapter;
  let l2: RedisAdapter;
  let manager: CacheManager;

  beforeEach(async () => {
    l1 = new MemoryAdapter();
    l2 = new RedisAdapter({ client: redis, prefix: TEST_PREFIX });
    await l2.clear();
    manager = new CacheManager({
      layers: [l1, l2],
      syncBackfill: true,
    });
  });

  describe("sequential layer lookup", () => {
    it("should return from L1 (memory) when present", async () => {
      await manager.set("key1", "value1");
      const result = await manager.get<string>("key1");
      expect(result!.value).toBe("value1");
    });

    it("should fall through to L2 (Redis) on L1 miss", async () => {
      // Put directly in Redis, skip memory
      await l2.set("key1", "only-in-redis");

      const result = await manager.get<string>("key1");
      expect(result!.value).toBe("only-in-redis");
    });

    it("should return null when both layers miss", async () => {
      const result = await manager.get("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("automatic backfill", () => {
    it("should backfill L1 from L2 on L2 hit", async () => {
      // Put only in Redis
      await l2.set("backfill-key", "from-redis");

      // Get via manager — should find in L2 and backfill L1
      const result = await manager.get<string>("backfill-key");
      expect(result!.value).toBe("from-redis");

      // L1 should now have the value
      const l1Result = await l1.get<string>("backfill-key");
      expect(l1Result).not.toBeNull();
      expect(l1Result!.value).toBe("from-redis");
    });

    it("should backfill L1 with correct TTL from L2", async () => {
      // Set in Redis with TTL
      await l2.set("ttl-backfill", "value", 5000);

      await manager.get<string>("ttl-backfill");

      const l1Result = await l1.get<string>("ttl-backfill");
      expect(l1Result).not.toBeNull();
      // L1 expiresAt should be roughly in the future
      expect(l1Result!.expiresAt).toBeTypeOf("number");
      expect(l1Result!.expiresAt!).toBeGreaterThan(Date.now());
    });
  });

  describe("wrap with real layers", () => {
    it("should compute, cache in both layers, and return on subsequent calls", async () => {
      let factoryCalls = 0;
      const factory = async () => {
        factoryCalls++;
        return { user: "Alice", id: 42 };
      };

      const result1 = await manager.wrap("user:42", factory, 10000);
      expect(result1).toEqual({ user: "Alice", id: 42 });
      expect(factoryCalls).toBe(1);

      // Value should be in both layers
      const l1Result = await l1.get<{ user: string; id: number }>("user:42");
      const l2Result = await l2.get<{ user: string; id: number }>("user:42");
      expect(l1Result!.value).toEqual({ user: "Alice", id: 42 });
      expect(l2Result!.value).toEqual({ user: "Alice", id: 42 });

      // Second call should not invoke factory
      const result2 = await manager.wrap("user:42", factory, 10000);
      expect(result2).toEqual({ user: "Alice", id: 42 });
      expect(factoryCalls).toBe(1);
    });

    it("should re-compute after L1 eviction if L2 still has it", async () => {
      let factoryCalls = 0;
      const factory = async () => {
        factoryCalls++;
        return `computed-${factoryCalls}`;
      };

      await manager.wrap("evict-test", factory, 10000);
      expect(factoryCalls).toBe(1);

      // Evict from L1 only
      await l1.delete("evict-test");

      // Should find in L2, not call factory again
      const result = await manager.wrap("evict-test", factory, 10000);
      expect(result).toBe("computed-1");
      expect(factoryCalls).toBe(1);
    });
  });

  describe("stampede protection with real Redis", () => {
    it("should coalesce concurrent wrap calls", async () => {
      let factoryCalls = 0;
      const factory = async () => {
        factoryCalls++;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return "coalesced-value";
      };

      const promises = Array.from({ length: 20 }, () =>
        manager.wrap("stampede-key", factory),
      );
      const results = await Promise.all(promises);

      expect(factoryCalls).toBe(1);
      for (const result of results) {
        expect(result).toBe("coalesced-value");
      }

      // Value should be in Redis
      const redisResult = await l2.get<string>("stampede-key");
      expect(redisResult!.value).toBe("coalesced-value");
    });
  });

  describe("set/delete across layers", () => {
    it("should set in both L1 and L2", async () => {
      await manager.set("both-key", "both-value");
      expect((await l1.get<string>("both-key"))!.value).toBe("both-value");
      expect((await l2.get<string>("both-key"))!.value).toBe("both-value");
    });

    it("should delete from both L1 and L2", async () => {
      await manager.set("del-key", "to-delete");
      await manager.delete("del-key");
      expect(await l1.get("del-key")).toBeNull();
      expect(await l2.get("del-key")).toBeNull();
    });

    it("should clear both L1 and L2 via getLayers()", async () => {
      await manager.set("c1", "v1");
      await manager.set("c2", "v2");
      for (const layer of manager.getLayers()) {
        await layer.clear();
      }
      expect(await l1.get("c1")).toBeNull();
      expect(await l2.get("c1")).toBeNull();
    });
  });
});
