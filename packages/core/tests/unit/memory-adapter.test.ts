import { describe, it, expect, beforeEach } from "vitest";
import { MemoryAdapter } from "../../src/memory-adapter.js";

describe("MemoryAdapter", () => {
  let adapter: MemoryAdapter;

  beforeEach(() => {
    adapter = new MemoryAdapter();
  });

  describe("constructor", () => {
    it("should create an adapter with default options", () => {
      const a = new MemoryAdapter();
      expect(a.name).toBe("memory");
    });

    it("should accept options", () => {
      const a = new MemoryAdapter({ defaultTtlMs: 5000 });
      expect(a.name).toBe("memory");
    });
  });

  describe("name", () => {
    it('should return "memory"', () => {
      expect(adapter.name).toBe("memory");
    });
  });

  describe("get", () => {
    it("should return null for a key that does not exist", async () => {
      const result = await adapter.get("missing");
      expect(result).toBeNull();
    });

    it("should return a CacheEntry with value on cache hit", async () => {
      await adapter.set("key1", "hello");
      const result = await adapter.get<string>("key1");
      expect(result).not.toBeNull();
      expect(result!.value).toBe("hello");
    });

    it("should return expiresAt as null when no TTL", async () => {
      await adapter.set("key1", "hello");
      const result = await adapter.get<string>("key1");
      expect(result!.expiresAt).toBeNull();
    });

    it("should return expiresAt as a future timestamp when TTL is set", async () => {
      const before = Date.now();
      await adapter.set("key1", "hello", 5000);
      const result = await adapter.get<string>("key1");
      expect(result!.expiresAt).toBeTypeOf("number");
      expect(result!.expiresAt!).toBeGreaterThanOrEqual(before + 5000);
    });
  });

  describe("set", () => {
    it("should store a string value", async () => {
      await adapter.set("s", "hello");
      const result = await adapter.get<string>("s");
      expect(result!.value).toBe("hello");
    });

    it("should store a number value", async () => {
      await adapter.set("n", 42);
      const result = await adapter.get<number>("n");
      expect(result!.value).toBe(42);
    });

    it("should store an object value", async () => {
      await adapter.set("o", { a: 1 });
      const result = await adapter.get<{ a: number }>("o");
      expect(result!.value).toEqual({ a: 1 });
    });

    it("should overwrite an existing key", async () => {
      await adapter.set("k", "v1");
      await adapter.set("k", "v2");
      const result = await adapter.get<string>("k");
      expect(result!.value).toBe("v2");
    });
  });

  describe("TTL / expiry", () => {
    it("should return null after TTL expires", async () => {
      await adapter.set("k", "v", 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = await adapter.get("k");
      expect(result).toBeNull();
    });

    it("should return value before TTL expires", async () => {
      await adapter.set("k", "v", 10000);
      const result = await adapter.get<string>("k");
      expect(result!.value).toBe("v");
    });

    it("should not expire entries without TTL", async () => {
      await adapter.set("k", "v");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = await adapter.get<string>("k");
      expect(result).not.toBeNull();
    });
  });

  describe("delete", () => {
    it("should remove a key", async () => {
      await adapter.set("k", "v");
      await adapter.delete("k");
      expect(await adapter.get("k")).toBeNull();
    });

    it("should not throw when deleting nonexistent key", async () => {
      await expect(adapter.delete("nope")).resolves.not.toThrow();
    });

    it("should leave other keys intact", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      await adapter.delete("a");
      expect(await adapter.get("a")).toBeNull();
      expect((await adapter.get<number>("b"))!.value).toBe(2);
    });
  });

  describe("clear", () => {
    it("should remove all entries", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      await adapter.clear();
      expect(await adapter.get("a")).toBeNull();
      expect(await adapter.get("b")).toBeNull();
    });

    it("should not throw when already empty", async () => {
      await expect(adapter.clear()).resolves.not.toThrow();
    });
  });

  describe("defaultTtlMs", () => {
    it("should apply defaultTtlMs when no ttlMs is passed to set", async () => {
      const a = new MemoryAdapter({ defaultTtlMs: 5000 });
      const before = Date.now();
      await a.set("k", "v");
      const result = await a.get<string>("k");
      expect(result!.expiresAt).toBeTypeOf("number");
      expect(result!.expiresAt!).toBeGreaterThanOrEqual(before + 5000);
    });

    it("should use defaultTtlMs over caller-provided ttlMs", async () => {
      const a = new MemoryAdapter({ defaultTtlMs: 5000 });
      const before = Date.now();
      await a.set("k", "v", 60000);
      const result = await a.get<string>("k");
      // Should use adapter's 5000ms, not caller's 60000ms
      expect(result!.expiresAt!).toBeLessThan(before + 10000);
    });

    it("should expire entries based on defaultTtlMs", async () => {
      const a = new MemoryAdapter({ defaultTtlMs: 1 });
      await a.set("k", "v");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await a.get("k")).toBeNull();
    });

    it("should use caller ttlMs as fallback when no defaultTtlMs", async () => {
      const a = new MemoryAdapter();
      const before = Date.now();
      await a.set("k", "v", 5000);
      const result = await a.get<string>("k");
      expect(result!.expiresAt!).toBeGreaterThanOrEqual(before + 5000);
    });
  });
});
