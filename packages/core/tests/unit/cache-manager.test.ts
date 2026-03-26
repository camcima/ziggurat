import { describe, it, expect, beforeEach, vi } from "vitest";
import { CacheManager } from "../../src/cache-manager.js";
import { MemoryAdapter } from "../../src/memory-adapter.js";

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
