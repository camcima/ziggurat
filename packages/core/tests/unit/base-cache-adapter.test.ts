import { describe, it, expect, beforeEach } from "vitest";
import { BaseCacheAdapter } from "../../src/base-cache-adapter.js";
import type { CacheEntry } from "../../src/types.js";

class InMemoryAdapter extends BaseCacheAdapter {
  readonly name = "in-memory";
  private store = new Map<
    string,
    { value: unknown; expiresAt: number | null }
  >();

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt !== null && item.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return { value: item.value as T, expiresAt: item.expiresAt };
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.store.set(key, {
      value,
      expiresAt: ttlMs ? Date.now() + ttlMs : null,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

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

describe("BaseCacheAdapter default implementations", () => {
  let adapter: InMemoryAdapter;

  beforeEach(() => {
    adapter = new InMemoryAdapter();
  });

  describe("has", () => {
    it("should return false for missing key", async () => {
      expect(await adapter.has("nope")).toBe(false);
    });

    it("should return true for existing key", async () => {
      await adapter.set("a", 1);
      expect(await adapter.has("a")).toBe(true);
    });
  });

  describe("getTtl", () => {
    it("should return missing for nonexistent key", async () => {
      expect(await adapter.getTtl("nope")).toEqual({ kind: "missing" });
    });

    it("should return permanent for key without TTL", async () => {
      await adapter.set("a", 1);
      expect(await adapter.getTtl("a")).toEqual({ kind: "permanent" });
    });

    it("should return expiring with remaining ttlMs for key with TTL", async () => {
      await adapter.set("a", 1, 60_000);
      const result = await adapter.getTtl("a");
      expect(result.kind).toBe("expiring");
      if (result.kind === "expiring") {
        expect(result.ttlMs).toBeGreaterThan(0);
        expect(result.ttlMs).toBeLessThanOrEqual(60_000);
      }
    });
  });

  describe("keys", () => {
    it("should throw by default with adapter name in message", async () => {
      await expect(adapter.keys()).rejects.toThrow(
        "in-memory does not support key enumeration",
      );
    });
  });

  describe("flushAll", () => {
    it("should delegate to clear()", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      await adapter.flushAll();
      expect(await adapter.get("a")).toBeNull();
      expect(await adapter.get("b")).toBeNull();
    });
  });

  describe("mget", () => {
    it("should return entries for hits and omit misses", async () => {
      await adapter.set("a", 1);
      const result = await adapter.mget<number>(["a", "missing"]);
      expect(result.get("a")!.value).toBe(1);
      expect(result.has("missing")).toBe(false);
    });
  });

  describe("mset", () => {
    it("should store multiple entries", async () => {
      await adapter.mset([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
      expect((await adapter.get<number>("a"))!.value).toBe(1);
      expect((await adapter.get<number>("b"))!.value).toBe(2);
    });
  });

  describe("mdel", () => {
    it("should delete multiple keys", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      await adapter.mdel(["a", "b"]);
      expect(await adapter.get("a")).toBeNull();
      expect(await adapter.get("b")).toBeNull();
    });
  });
});

describe("BaseCacheAdapter batch error propagation", () => {
  const adapter = new FailingAdapter();

  it("mget should reject when underlying get calls fail", async () => {
    await expect(adapter.mget(["a", "b"])).rejects.toThrow("get failed");
  });

  it("mset should reject when underlying set calls fail", async () => {
    await expect(adapter.mset([{ key: "a", value: 1 }])).rejects.toThrow(
      "set failed",
    );
  });

  it("mdel should reject when underlying delete calls fail", async () => {
    await expect(adapter.mdel(["a"])).rejects.toThrow("delete failed");
  });

  it("flushAll should reject when clear fails", async () => {
    await expect(adapter.flushAll()).rejects.toThrow("clear failed");
  });

  it("has should reject when get fails", async () => {
    await expect(adapter.has("a")).rejects.toThrow("get failed");
  });

  it("getTtl should reject when get fails", async () => {
    await expect(adapter.getTtl("a")).rejects.toThrow("get failed");
  });
});
