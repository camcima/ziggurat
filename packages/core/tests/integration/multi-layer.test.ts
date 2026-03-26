import { describe, it, expect, beforeEach, vi } from "vitest";
import { CacheManager } from "../../src/cache-manager.js";
import { MemoryAdapter } from "../../src/memory-adapter.js";

describe("Multi-Layer Cache", () => {
  let l1: MemoryAdapter;
  let l2: MemoryAdapter;
  let manager: CacheManager;

  beforeEach(() => {
    l1 = new MemoryAdapter();
    l2 = new MemoryAdapter();
    manager = new CacheManager({ layers: [l1, l2] });
  });

  describe("sequential layer lookup", () => {
    it("should return value from L1 when present", async () => {
      await l1.set("key1", "from-l1");
      await l2.set("key1", "from-l2");
      const result = await manager.get<string>("key1");
      expect(result!.value).toBe("from-l1");
    });

    it("should fall through to L2 on L1 miss", async () => {
      await l2.set("key1", "from-l2");
      const result = await manager.get<string>("key1");
      expect(result!.value).toBe("from-l2");
    });

    it("should return null when all layers miss", async () => {
      const result = await manager.get("nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("automatic backfill", () => {
    it("should backfill L1 when value found in L2", async () => {
      await l2.set("key1", "from-l2");

      const syncManager = new CacheManager({
        layers: [l1, l2],
        syncBackfill: true,
      });

      await syncManager.get<string>("key1");

      // L1 should now have the value
      const l1Entry = await l1.get<string>("key1");
      expect(l1Entry).not.toBeNull();
      expect(l1Entry!.value).toBe("from-l2");
    });

    it("should backfill L1 and L2 when value found in L3", async () => {
      const l3 = new MemoryAdapter();
      const syncManager = new CacheManager({
        layers: [l1, l2, l3],
        syncBackfill: true,
      });

      await l3.set("key1", "from-l3");
      await syncManager.get<string>("key1");

      const l1Entry = await l1.get<string>("key1");
      const l2Entry = await l2.get<string>("key1");
      expect(l1Entry!.value).toBe("from-l3");
      expect(l2Entry!.value).toBe("from-l3");
    });

    it("should not backfill when value found in L1 (first layer)", async () => {
      const setSpy = vi.spyOn(l2, "set");
      await l1.set("key1", "from-l1");

      const syncManager = new CacheManager({
        layers: [l1, l2],
        syncBackfill: true,
      });
      await syncManager.get<string>("key1");

      expect(setSpy).not.toHaveBeenCalled();
    });
  });

  describe("async vs sync backfill", () => {
    it("should backfill asynchronously by default (fire-and-forget)", async () => {
      await l2.set("key1", "from-l2");

      const asyncManager = new CacheManager({ layers: [l1, l2] });
      const result = await asyncManager.get<string>("key1");
      expect(result!.value).toBe("from-l2");

      // Give async backfill time to complete
      await new Promise((resolve) => setTimeout(resolve, 50));
      const l1Entry = await l1.get<string>("key1");
      expect(l1Entry!.value).toBe("from-l2");
    });

    it("should backfill synchronously when syncBackfill is true", async () => {
      await l2.set("key1", "from-l2");

      const syncManager = new CacheManager({
        layers: [l1, l2],
        syncBackfill: true,
      });
      await syncManager.get<string>("key1");

      // Backfill should be complete immediately (no waiting needed)
      const l1Entry = await l1.get<string>("key1");
      expect(l1Entry!.value).toBe("from-l2");
    });
  });

  describe("set across all layers", () => {
    it("should set value in all layers", async () => {
      await manager.set("key1", "value1");
      const l1Entry = await l1.get<string>("key1");
      const l2Entry = await l2.get<string>("key1");
      expect(l1Entry!.value).toBe("value1");
      expect(l2Entry!.value).toBe("value1");
    });

    it("should set with TTL in all layers", async () => {
      await manager.set("key1", "value1", 5000);
      const l1Entry = await l1.get<string>("key1");
      const l2Entry = await l2.get<string>("key1");
      expect(l1Entry!.expiresAt).toBeTypeOf("number");
      expect(l2Entry!.expiresAt).toBeTypeOf("number");
    });
  });

  describe("delete across all layers", () => {
    it("should delete from all layers", async () => {
      await manager.set("key1", "value1");
      await manager.delete("key1");
      expect(await l1.get("key1")).toBeNull();
      expect(await l2.get("key1")).toBeNull();
    });
  });

  describe("backfill with adapter-level TTL", () => {
    it("should use adapter defaultTtlMs for backfill instead of source TTL", async () => {
      const l1WithTtl = new MemoryAdapter({ defaultTtlMs: 1000 });
      const l2NoTtl = new MemoryAdapter();
      const syncManager = new CacheManager({
        layers: [l1WithTtl, l2NoTtl],
        syncBackfill: true,
      });

      // Set in L2 with a long TTL
      await l2NoTtl.set("key1", "value1", 60000);

      // Get via manager — should backfill L1
      await syncManager.get<string>("key1");

      // L1 should have the value with its OWN defaultTtlMs, not L2's TTL
      const l1Entry = await l1WithTtl.get<string>("key1");
      expect(l1Entry).not.toBeNull();
      expect(l1Entry!.expiresAt).toBeTypeOf("number");
      // L1 TTL should be ~1000ms, not ~60000ms
      const remainingTtl = l1Entry!.expiresAt! - Date.now();
      expect(remainingTtl).toBeLessThan(2000);
      expect(remainingTtl).toBeGreaterThan(0);
    });

    it("should fall back to remaining TTL when adapter has no defaultTtlMs", async () => {
      const l1Plain = new MemoryAdapter();
      const l2Plain = new MemoryAdapter();
      const syncManager = new CacheManager({
        layers: [l1Plain, l2Plain],
        syncBackfill: true,
      });

      // Set in L2 with 5s TTL
      await l2Plain.set("key1", "value1", 5000);
      await syncManager.get<string>("key1");

      // L1 should have backfilled with approximately the remaining TTL from L2
      const l1Entry = await l1Plain.get<string>("key1");
      expect(l1Entry).not.toBeNull();
      expect(l1Entry!.expiresAt).toBeTypeOf("number");
      const remainingTtl = l1Entry!.expiresAt! - Date.now();
      expect(remainingTtl).toBeGreaterThan(4000);
      expect(remainingTtl).toBeLessThanOrEqual(5000);
    });
  });

  describe("namespace with multi-layer", () => {
    it("should namespace keys across all layers", async () => {
      const nsManager = new CacheManager({
        layers: [l1, l2],
        namespace: "users",
        syncBackfill: true,
      });

      await nsManager.set("42", "Alice");
      // Both layers should have the namespaced key
      expect((await l1.get<string>("users:42"))!.value).toBe("Alice");
      expect((await l2.get<string>("users:42"))!.value).toBe("Alice");
    });

    it("should backfill with namespaced keys", async () => {
      const nsManager = new CacheManager({
        layers: [l1, l2],
        namespace: "users",
        syncBackfill: true,
      });

      // Set directly in L2 with namespaced key
      await l2.set("users:42", "Alice");

      // Get via manager should find it and backfill L1
      const result = await nsManager.get<string>("42");
      expect(result!.value).toBe("Alice");

      const l1Entry = await l1.get<string>("users:42");
      expect(l1Entry!.value).toBe("Alice");
    });
  });

  describe("batch operations across layers", () => {
    it("mget should collect hits from multiple layers with backfill", async () => {
      const syncManager = new CacheManager({
        layers: [l1, l2],
        syncBackfill: true,
      });

      await l1.set("a", 1);
      await l2.set("b", 2);

      const result = await syncManager.mget<number>(["a", "b", "missing"]);
      expect(result.get("a")!.value).toBe(1);
      expect(result.get("b")!.value).toBe(2);
      expect(result.has("missing")).toBe(false);

      // "b" should be backfilled to L1
      const l1b = await l1.get<number>("b");
      expect(l1b!.value).toBe(2);
    });

    it("mget should not query lower layers for already-found keys", async () => {
      const mgetSpy = vi.spyOn(l2, "mget");
      await l1.set("a", 1);
      await l1.set("b", 2);

      await manager.mget<number>(["a", "b"]);
      // L2 should not be queried since all keys were found in L1
      // (or it's queried with an empty set)
      if (mgetSpy.mock.calls.length > 0) {
        expect(mgetSpy.mock.calls[0][0]).toHaveLength(0);
      }
    });

    it("mset should write to all layers", async () => {
      await manager.mset([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
      expect((await l1.get<number>("a"))!.value).toBe(1);
      expect((await l2.get<number>("a"))!.value).toBe(1);
      expect((await l1.get<number>("b"))!.value).toBe(2);
      expect((await l2.get<number>("b"))!.value).toBe(2);
    });

    it("mdel should delete from all layers", async () => {
      await manager.set("a", 1);
      await manager.set("b", 2);
      await manager.set("c", 3);
      await manager.mdel(["a", "c"]);
      expect(await l1.get("a")).toBeNull();
      expect(await l2.get("a")).toBeNull();
      expect(await l1.get("c")).toBeNull();
      expect(await l2.get("c")).toBeNull();
      expect((await l1.get<number>("b"))!.value).toBe(2);
    });

    it("getTtl should walk layers and return first hit", async () => {
      await l2.set("key1", "value1", 60000);
      const result = await manager.getTtl("key1");
      expect(result.kind).toBe("expiring");
    });

    it("has should return true if key exists in any layer", async () => {
      await l2.set("key1", "value1");
      expect(await manager.has("key1")).toBe(true);
      expect(await manager.has("missing")).toBe(false);
    });

    it("mget with namespace should use namespaced keys and return unnamespaced", async () => {
      const nsManager = new CacheManager({
        layers: [l1, l2],
        namespace: "ns",
        syncBackfill: true,
      });
      await l2.set("ns:x", 10);
      const result = await nsManager.mget<number>(["x"]);
      expect(result.get("x")!.value).toBe(10);
      // backfilled to L1 with namespaced key
      expect((await l1.get<number>("ns:x"))!.value).toBe(10);
    });
  });

  describe("adapter failure handling", () => {
    it("should skip a failing layer on get and continue to next", async () => {
      const failingAdapter = {
        name: "failing",
        get: vi.fn().mockRejectedValue(new Error("get failed")),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      };

      const failManager = new CacheManager({
        layers: [failingAdapter, l2],
      });

      await l2.set("key1", "from-l2");
      const result = await failManager.get<string>("key1");
      expect(result!.value).toBe("from-l2");
    });

    it("should continue set even if one layer fails", async () => {
      const failingAdapter = {
        name: "failing",
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockRejectedValue(new Error("set failed")),
        delete: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
      };

      const failManager = new CacheManager({
        layers: [failingAdapter, l2],
      });

      await failManager.set("key1", "value1");
      const l2Entry = await l2.get<string>("key1");
      expect(l2Entry!.value).toBe("value1");
    });

    it("should continue delete even if one layer fails", async () => {
      const failingAdapter = {
        name: "failing",
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockRejectedValue(new Error("delete failed")),
        clear: vi.fn().mockResolvedValue(undefined),
      };

      const failManager = new CacheManager({
        layers: [failingAdapter, l2],
      });

      await l2.set("key1", "value1");
      await failManager.delete("key1");
      expect(await l2.get("key1")).toBeNull();
    });
  });
});
