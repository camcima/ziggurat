import { describe, it, expect, beforeEach, vi } from "vitest";
import { CacheManager } from "../../src/cache-manager.js";
import { MemoryAdapter } from "../../src/memory-adapter.js";
import { BaseCacheAdapter } from "../../src/base-cache-adapter.js";
import type {
  CacheEntry,
  CacheHitEvent,
  CacheMissEvent,
  CacheErrorEvent,
  CacheBackfillEvent,
  CacheWrapHitEvent,
  CacheWrapMissEvent,
  CacheWrapCoalesceEvent,
  CacheSetEvent,
  CacheDeleteEvent,
  CacheMgetEvent,
  CacheMsetEvent,
  CacheMdelEvent,
} from "../../src/types.js";

describe("CacheManager (single-layer)", () => {
  let manager: CacheManager;
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
    manager = new CacheManager({ layers: [adapter] });
  });

  describe("get", () => {
    it("should return null on cache miss", async () => {
      const result = await manager.get("missing");
      expect(result).toBeNull();
    });

    it("should return CacheEntry on cache hit", async () => {
      await manager.set("key1", "value1");
      const result = await manager.get<string>("key1");
      expect(result).not.toBeNull();
      expect(result!.value).toBe("value1");
    });
  });

  describe("set", () => {
    it("should store a value retrievable via get", async () => {
      await manager.set("key1", "value1");
      const result = await manager.get<string>("key1");
      expect(result!.value).toBe("value1");
    });

    it("should store a value with TTL", async () => {
      await manager.set("key1", "value1", 5000);
      const result = await manager.get<string>("key1");
      expect(result!.value).toBe("value1");
      expect(result!.expiresAt).toBeTypeOf("number");
    });
  });

  describe("delete", () => {
    it("should remove a cached key", async () => {
      await manager.set("key1", "value1");
      await manager.delete("key1");
      const result = await manager.get("key1");
      expect(result).toBeNull();
    });

    it("should not throw when deleting nonexistent key", async () => {
      await expect(manager.delete("nope")).resolves.not.toThrow();
    });
  });

  describe("namespace", () => {
    it("should prepend namespace to keys on set and get", async () => {
      const nsManager = new CacheManager({
        layers: [adapter],
        namespace: "users",
      });

      await nsManager.set("42", "Alice");
      // Direct adapter access should show the namespaced key
      const directResult = await adapter.get<string>("users:42");
      expect(directResult!.value).toBe("Alice");
      // Manager get should also work with the raw key
      const result = await nsManager.get<string>("42");
      expect(result!.value).toBe("Alice");
    });

    it("should prepend namespace to keys on delete", async () => {
      const nsManager = new CacheManager({
        layers: [adapter],
        namespace: "users",
      });

      await nsManager.set("42", "Alice");
      await nsManager.delete("42");
      expect(await adapter.get("users:42")).toBeNull();
    });

    it("should prepend namespace to keys on wrap", async () => {
      const nsManager = new CacheManager({
        layers: [adapter],
        namespace: "users",
      });

      const result = await nsManager.wrap("42", async () => "Alice");
      expect(result).toBe("Alice");
      const directResult = await adapter.get<string>("users:42");
      expect(directResult!.value).toBe("Alice");
    });

    it("should not modify keys when namespace is not set", async () => {
      await manager.set("key1", "value1");
      const directResult = await adapter.get<string>("key1");
      expect(directResult!.value).toBe("value1");
    });

    it("should isolate keys between different namespaces", async () => {
      const userCache = new CacheManager({
        layers: [adapter],
        namespace: "users",
      });
      const productCache = new CacheManager({
        layers: [adapter],
        namespace: "products",
      });

      await userCache.set("42", "Alice");
      await productCache.set("42", "Widget");

      expect((await userCache.get<string>("42"))!.value).toBe("Alice");
      expect((await productCache.get<string>("42"))!.value).toBe("Widget");
    });
  });

  describe("del", () => {
    it("should remove a cached key (alias for delete)", async () => {
      await manager.set("key1", "value1");
      await manager.del("key1");
      expect(await manager.get("key1")).toBeNull();
    });
  });

  describe("mget", () => {
    it("should return entries for hits and omit misses", async () => {
      await manager.set("a", 1);
      await manager.set("b", 2);
      const result = await manager.mget<number>(["a", "b", "missing"]);
      expect(result.get("a")!.value).toBe(1);
      expect(result.get("b")!.value).toBe(2);
      expect(result.has("missing")).toBe(false);
    });

    it("should apply namespace prefix and return unnamespaced keys", async () => {
      const nsManager = new CacheManager({
        layers: [adapter],
        namespace: "ns",
      });
      await nsManager.set("x", 10);
      const result = await nsManager.mget<number>(["x"]);
      expect(result.get("x")!.value).toBe(10);
    });

    it("should return empty Map for empty key list", async () => {
      const result = await manager.mget([]);
      expect(result.size).toBe(0);
    });
  });

  describe("mset", () => {
    it("should store multiple entries retrievable via get", async () => {
      await manager.mset([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
      expect((await manager.get<number>("a"))!.value).toBe(1);
      expect((await manager.get<number>("b"))!.value).toBe(2);
    });

    it("should apply namespace prefix", async () => {
      const nsManager = new CacheManager({
        layers: [adapter],
        namespace: "ns",
      });
      await nsManager.mset([{ key: "x", value: 42 }]);
      const direct = await adapter.get<number>("ns:x");
      expect(direct!.value).toBe(42);
    });
  });

  describe("mdel", () => {
    it("should remove multiple keys", async () => {
      await manager.set("a", 1);
      await manager.set("b", 2);
      await manager.set("c", 3);
      await manager.mdel(["a", "c"]);
      expect(await manager.get("a")).toBeNull();
      expect(await manager.get("b")).not.toBeNull();
      expect(await manager.get("c")).toBeNull();
    });
  });

  describe("getTtl", () => {
    it("should return missing for nonexistent key", async () => {
      const result = await manager.getTtl("nope");
      expect(result).toEqual({ kind: "missing" });
    });

    it("should return permanent for key without TTL", async () => {
      await manager.set("key1", "value1");
      const result = await manager.getTtl("key1");
      expect(result).toEqual({ kind: "permanent" });
    });

    it("should return expiring for key with TTL", async () => {
      await manager.set("key1", "value1", 60000);
      const result = await manager.getTtl("key1");
      expect(result.kind).toBe("expiring");
      if (result.kind === "expiring") {
        expect(result.ttlMs).toBeGreaterThan(0);
      }
    });
  });

  describe("has", () => {
    it("should return false for missing key", async () => {
      expect(await manager.has("nope")).toBe(false);
    });

    it("should return true for present key", async () => {
      await manager.set("key1", "value1");
      expect(await manager.has("key1")).toBe(true);
    });
  });

  describe("getLayers", () => {
    it("should return adapters in configured order", () => {
      const a1 = new MemoryAdapter();
      const a2 = new MemoryAdapter();
      const mgr = new CacheManager({ layers: [a1, a2] });
      const layers = mgr.getLayers();
      expect(layers).toHaveLength(2);
      expect(layers[0]).toBe(a1);
      expect(layers[1]).toBe(a2);
    });

    it("should return a new array each call (mutations do not affect internal state)", () => {
      const a1 = new MemoryAdapter();
      const a2 = new MemoryAdapter();
      const mgr = new CacheManager({ layers: [a1, a2] });
      const first = mgr.getLayers();
      first.push(new MemoryAdapter() as never);
      const second = mgr.getLayers();
      expect(second).toHaveLength(2);
      expect(first).not.toBe(second);
    });

    it("should allow adapter-level clear() on one layer without affecting others", async () => {
      const a1 = new MemoryAdapter();
      const a2 = new MemoryAdapter();
      const mgr = new CacheManager({ layers: [a1, a2] });
      await mgr.set("key1", "value1");
      const [layer1] = mgr.getLayers();
      await layer1.clear();
      // L1 cleared
      expect(await a1.get("key1")).toBeNull();
      // L2 untouched
      expect((await a2.get<string>("key1"))!.value).toBe("value1");
    });
  });

  describe("wrap", () => {
    it("should invoke factory on cache miss and return result", async () => {
      const factory = vi.fn().mockResolvedValue("computed");
      const result = await manager.wrap("key1", factory);
      expect(result).toBe("computed");
      expect(factory).toHaveBeenCalledOnce();
    });

    it("should return cached value without calling factory on hit", async () => {
      await manager.set("key1", "cached");
      const factory = vi.fn().mockResolvedValue("computed");
      const result = await manager.wrap("key1", factory);
      expect(result).toBe("cached");
      expect(factory).not.toHaveBeenCalled();
    });

    it("should cache the value from factory for subsequent calls", async () => {
      let callCount = 0;
      const factory = vi.fn().mockImplementation(async () => {
        callCount++;
        return `result-${callCount}`;
      });

      const first = await manager.wrap("key1", factory);
      const second = await manager.wrap("key1", factory);

      expect(first).toBe("result-1");
      expect(second).toBe("result-1");
      expect(factory).toHaveBeenCalledOnce();
    });

    it("should apply TTL when provided", async () => {
      const factory = vi.fn().mockResolvedValue("value");
      await manager.wrap("key1", factory, 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = await manager.get("key1");
      expect(result).toBeNull();
    });

    it("should store without TTL when ttlMs is omitted", async () => {
      const factory = vi.fn().mockResolvedValue("value");
      await manager.wrap("key1", factory);
      const result = await manager.get<string>("key1");
      expect(result!.expiresAt).toBeNull();
    });

    it("should propagate factory errors", async () => {
      const factory = vi.fn().mockRejectedValue(new Error("factory failed"));
      await expect(manager.wrap("key1", factory)).rejects.toThrow(
        "factory failed",
      );
    });

    it("should not cache when factory throws", async () => {
      const factory = vi.fn().mockRejectedValue(new Error("fail"));
      await expect(manager.wrap("key1", factory)).rejects.toThrow();
      const result = await manager.get("key1");
      expect(result).toBeNull();
    });
  });
});

// ── Failing adapter for error event testing ──

class FailingAdapter extends BaseCacheAdapter {
  readonly name = "failing";
  async get<T>(): Promise<CacheEntry<T> | null> {
    throw new Error("get failed");
  }
  async set(): Promise<void> {
    throw new Error("set failed");
  }
  async delete(): Promise<void> {
    throw new Error("delete failed");
  }
  async clear(): Promise<void> {
    throw new Error("clear failed");
  }
}

describe("CacheManager events", () => {
  describe("hit / miss", () => {
    it("should emit hit event on cache hit", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const hits: CacheHitEvent[] = [];
      manager.on("hit", (e) => hits.push(e));

      await manager.set("key1", "value1");
      await manager.get("key1");

      expect(hits).toHaveLength(1);
      expect(hits[0].key).toBe("key1");
      expect(hits[0].layerName).toBe("memory");
      expect(hits[0].layerIndex).toBe(0);
      expect(hits[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should emit miss event on cache miss", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const misses: CacheMissEvent[] = [];
      manager.on("miss", (e) => misses.push(e));

      await manager.get("nonexistent");

      expect(misses).toHaveLength(1);
      expect(misses[0].key).toBe("nonexistent");
      expect(misses[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should include namespace in events", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({
        layers: [adapter],
        namespace: "ns",
      });
      const hits: CacheHitEvent[] = [];
      manager.on("hit", (e) => hits.push(e));

      await manager.set("key1", "value1");
      await manager.get("key1");

      expect(hits[0].namespace).toBe("ns");
      expect(hits[0].key).toBe("key1");
    });

    it("should emit hit with correct layer info for L2 hit", async () => {
      const l1 = new MemoryAdapter();
      const l2 = new MemoryAdapter();
      const manager = new CacheManager({
        layers: [l1, l2],
        syncBackfill: true,
      });
      const hits: CacheHitEvent[] = [];
      manager.on("hit", (e) => hits.push(e));

      await l2.set("key1", "value1");
      await manager.get("key1");

      expect(hits).toHaveLength(1);
      expect(hits[0].layerIndex).toBe(1);
      expect(hits[0].layerName).toBe("memory");
    });
  });

  describe("set / delete", () => {
    it("should emit set event", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const sets: CacheSetEvent[] = [];
      manager.on("set", (e) => sets.push(e));

      await manager.set("key1", "value1", 5000);

      expect(sets).toHaveLength(1);
      expect(sets[0].key).toBe("key1");
      expect(sets[0].ttlMs).toBe(5000);
      expect(sets[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should emit delete event", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const deletes: CacheDeleteEvent[] = [];
      manager.on("delete", (e) => deletes.push(e));

      await manager.set("key1", "value1");
      await manager.delete("key1");

      expect(deletes).toHaveLength(1);
      expect(deletes[0].key).toBe("key1");
      expect(deletes[0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("error", () => {
    it("should emit error event when a layer throws on get", async () => {
      const failing = new FailingAdapter();
      const healthy = new MemoryAdapter();
      const manager = new CacheManager({ layers: [failing, healthy] });
      const errors: CacheErrorEvent[] = [];
      manager.on("error", (e) => errors.push(e));

      await healthy.set("key1", "value1");
      await manager.get("key1");

      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe("get");
      expect(errors[0].layerName).toBe("failing");
      expect(errors[0].layerIndex).toBe(0);
      expect(errors[0].error).toBeInstanceOf(Error);
    });

    it("should emit error event when a layer throws on has", async () => {
      const failing = new FailingAdapter();
      const manager = new CacheManager({ layers: [failing] });
      const errors: CacheErrorEvent[] = [];
      manager.on("error", (e) => errors.push(e));

      await manager.has("key1");

      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe("has");
    });

    it("should emit error event when a layer throws on set", async () => {
      const failing = new FailingAdapter();
      const healthy = new MemoryAdapter();
      const manager = new CacheManager({ layers: [failing, healthy] });
      const errors: CacheErrorEvent[] = [];
      manager.on("error", (e) => errors.push(e));

      await manager.set("key1", "value1");

      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe("set");
      expect(errors[0].layerName).toBe("failing");
      expect(errors[0].layerIndex).toBe(0);
      expect(errors[0].error).toBeInstanceOf(Error);
    });

    it("should emit error event when a layer throws on delete", async () => {
      const failing = new FailingAdapter();
      const healthy = new MemoryAdapter();
      const manager = new CacheManager({ layers: [failing, healthy] });
      const errors: CacheErrorEvent[] = [];
      manager.on("error", (e) => errors.push(e));

      await manager.delete("key1");

      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe("delete");
      expect(errors[0].layerName).toBe("failing");
      expect(errors[0].layerIndex).toBe(0);
    });

    it("should emit error event when a layer throws on mset", async () => {
      const failing = new FailingAdapter();
      const healthy = new MemoryAdapter();
      const manager = new CacheManager({ layers: [failing, healthy] });
      const errors: CacheErrorEvent[] = [];
      manager.on("error", (e) => errors.push(e));

      await manager.mset([{ key: "a", value: 1 }]);

      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe("mset");
      expect(errors[0].layerName).toBe("failing");
      expect(errors[0].layerIndex).toBe(0);
    });

    it("should emit error event when a layer throws on mdel", async () => {
      const failing = new FailingAdapter();
      const healthy = new MemoryAdapter();
      const manager = new CacheManager({ layers: [failing, healthy] });
      const errors: CacheErrorEvent[] = [];
      manager.on("error", (e) => errors.push(e));

      await manager.mdel(["a"]);

      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe("mdel");
      expect(errors[0].layerName).toBe("failing");
      expect(errors[0].layerIndex).toBe(0);
    });

    it("should emit error event when a layer throws on getTtl", async () => {
      const failing = new FailingAdapter();
      const manager = new CacheManager({ layers: [failing] });
      const errors: CacheErrorEvent[] = [];
      manager.on("error", (e) => errors.push(e));

      await manager.getTtl("key1");

      expect(errors).toHaveLength(1);
      expect(errors[0].operation).toBe("getTtl");
    });
  });

  describe("backfill", () => {
    it("should emit backfill event on L2 hit", async () => {
      const l1 = new MemoryAdapter();
      const l2 = new MemoryAdapter();
      const manager = new CacheManager({
        layers: [l1, l2],
        syncBackfill: true,
      });
      const backfills: CacheBackfillEvent[] = [];
      manager.on("backfill", (e) => backfills.push(e));

      await l2.set("key1", "value1");
      await manager.get("key1");

      expect(backfills).toHaveLength(1);
      expect(backfills[0].key).toBe("key1");
      expect(backfills[0].sourceLayerIndex).toBe(1);
      expect(backfills[0].targetLayerNames).toEqual(["memory"]);
    });

    it("should not emit backfill event on L1 hit", async () => {
      const l1 = new MemoryAdapter();
      const l2 = new MemoryAdapter();
      const manager = new CacheManager({ layers: [l1, l2] });
      const backfills: CacheBackfillEvent[] = [];
      manager.on("backfill", (e) => backfills.push(e));

      await l1.set("key1", "value1");
      await manager.get("key1");

      expect(backfills).toHaveLength(0);
    });
  });

  describe("wrap events", () => {
    it("should emit wrap:hit when wrap finds cached value", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const wrapHits: CacheWrapHitEvent[] = [];
      manager.on("wrap:hit", (e) => wrapHits.push(e));

      await manager.set("key1", "cached");
      await manager.wrap("key1", async () => "computed");

      expect(wrapHits).toHaveLength(1);
      expect(wrapHits[0].key).toBe("key1");
      expect(wrapHits[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should emit wrap:miss when factory is called", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const wrapMisses: CacheWrapMissEvent[] = [];
      manager.on("wrap:miss", (e) => wrapMisses.push(e));

      await manager.wrap("key1", async () => "computed");

      expect(wrapMisses).toHaveLength(1);
      expect(wrapMisses[0].key).toBe("key1");
      expect(wrapMisses[0].durationMs).toBeGreaterThanOrEqual(0);
      expect(wrapMisses[0].factoryDurationMs).toBeGreaterThanOrEqual(0);
    });

    it("should emit wrap:coalesce when joining in-flight fetch", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const coalesced: CacheWrapCoalesceEvent[] = [];
      manager.on("wrap:coalesce", (e) => coalesced.push(e));

      const slow = () =>
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("value"), 50),
        );

      const [r1, r2] = await Promise.all([
        manager.wrap("key1", slow),
        manager.wrap("key1", slow),
      ]);

      expect(r1).toBe("value");
      expect(r2).toBe("value");
      expect(coalesced).toHaveLength(1);
      expect(coalesced[0].key).toBe("key1");
    });
  });

  describe("batch events", () => {
    it("should emit mget event with hit/miss counts", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const mgets: CacheMgetEvent[] = [];
      manager.on("mget", (e) => mgets.push(e));

      await manager.set("a", 1);
      await manager.set("b", 2);
      await manager.mget(["a", "b", "c"]);

      expect(mgets).toHaveLength(1);
      expect(mgets[0].keys).toEqual(["a", "b", "c"]);
      expect(mgets[0].hitCount).toBe(2);
      expect(mgets[0].missCount).toBe(1);
      expect(mgets[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should emit mset event with key count", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const msets: CacheMsetEvent[] = [];
      manager.on("mset", (e) => msets.push(e));

      await manager.mset([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);

      expect(msets).toHaveLength(1);
      expect(msets[0].keyCount).toBe(2);
      expect(msets[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it("should emit mdel event with key count", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const mdels: CacheMdelEvent[] = [];
      manager.on("mdel", (e) => mdels.push(e));

      await manager.set("a", 1);
      await manager.set("b", 2);
      await manager.mdel(["a", "b"]);

      expect(mdels).toHaveLength(1);
      expect(mdels[0].keyCount).toBe(2);
      expect(mdels[0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("no listeners", () => {
    it("should not emit events when no listeners are attached", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });

      // These should work with no listeners (no errors, no overhead)
      await manager.set("key1", "value1");
      await manager.get("key1");
      await manager.get("missing");
      await manager.wrap("key2", async () => "val");
      await manager.delete("key1");
      await manager.mget(["key2"]);
      await manager.mset([{ key: "a", value: 1 }]);
      await manager.mdel(["a"]);
      await manager.has("key2");
      await manager.getTtl("key2");
    });
  });

  describe("unsubscribe", () => {
    it("should stop receiving events after unsubscribe", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const hits: CacheHitEvent[] = [];
      const unsub = manager.on("hit", (e) => hits.push(e));

      await manager.set("key1", "value1");
      await manager.get("key1");
      expect(hits).toHaveLength(1);

      unsub();
      await manager.get("key1");
      expect(hits).toHaveLength(1);
    });
  });
});
