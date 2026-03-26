import { describe, it, expect, beforeEach } from "vitest";
import type { CacheAdapter } from "../../src/types.js";
import { MemoryAdapter } from "../../src/memory-adapter.js";

export interface ContractTestOptions {
  supportsKeys?: boolean;
}

/**
 * Shared contract test factory for CacheAdapter implementations.
 *
 * Any adapter that implements CacheAdapter MUST pass these tests.
 * Usage:
 *   runAdapterContractTests("MemoryAdapter", () => new MemoryAdapter());
 */
export function runAdapterContractTests(
  adapterName: string,
  factory: () => CacheAdapter,
  options: ContractTestOptions = {},
): void {
  const { supportsKeys = true } = options;

  describe(`CacheAdapter contract: ${adapterName}`, () => {
    let adapter: CacheAdapter;

    beforeEach(async () => {
      adapter = factory();
      await adapter.clear();
    });

    describe("name", () => {
      it("should have a non-empty name", () => {
        expect(adapter.name).toBeTruthy();
        expect(typeof adapter.name).toBe("string");
      });
    });

    describe("get", () => {
      it("should return null on cache miss", async () => {
        const result = await adapter.get("nonexistent");
        expect(result).toBeNull();
      });

      it("should return CacheEntry with value and expiresAt on hit", async () => {
        await adapter.set("key1", "value1");
        const result = await adapter.get<string>("key1");
        expect(result).not.toBeNull();
        expect(result!.value).toBe("value1");
        expect(result).toHaveProperty("expiresAt");
      });

      it("should return expiresAt as null when no TTL is set", async () => {
        await adapter.set("key1", "value1");
        const result = await adapter.get<string>("key1");
        expect(result!.expiresAt).toBeNull();
      });

      it("should return expiresAt as a number when TTL is set", async () => {
        await adapter.set("key1", "value1", 60000);
        const result = await adapter.get<string>("key1");
        expect(result!.expiresAt).toBeTypeOf("number");
      });

      it("should handle different value types", async () => {
        await adapter.set("string", "hello");
        await adapter.set("number", 42);
        await adapter.set("boolean", true);
        await adapter.set("object", { foo: "bar" });
        await adapter.set("array", [1, 2, 3]);

        const s = await adapter.get<string>("string");
        expect(s!.value).toBe("hello");

        const n = await adapter.get<number>("number");
        expect(n!.value).toBe(42);

        const b = await adapter.get<boolean>("boolean");
        expect(b!.value).toBe(true);

        const o = await adapter.get<{ foo: string }>("object");
        expect(o!.value).toEqual({ foo: "bar" });

        const a = await adapter.get<number[]>("array");
        expect(a!.value).toEqual([1, 2, 3]);
      });
    });

    describe("set", () => {
      it("should store a value that can be retrieved", async () => {
        await adapter.set("key1", "value1");
        const result = await adapter.get<string>("key1");
        expect(result!.value).toBe("value1");
      });

      it("should overwrite existing values", async () => {
        await adapter.set("key1", "value1");
        await adapter.set("key1", "value2");
        const result = await adapter.get<string>("key1");
        expect(result!.value).toBe("value2");
      });

      it("should store with TTL", async () => {
        await adapter.set("key1", "value1", 5000);
        const result = await adapter.get<string>("key1");
        expect(result).not.toBeNull();
        expect(result!.value).toBe("value1");
      });
    });

    describe("TTL expiry", () => {
      it("should return null for expired entries", async () => {
        await adapter.set("key1", "value1", 1);
        // Wait for expiry
        await new Promise((resolve) => setTimeout(resolve, 50));
        const result = await adapter.get<string>("key1");
        expect(result).toBeNull();
      });

      it("should not expire entries without TTL", async () => {
        await adapter.set("key1", "value1");
        await new Promise((resolve) => setTimeout(resolve, 50));
        const result = await adapter.get<string>("key1");
        expect(result).not.toBeNull();
        expect(result!.value).toBe("value1");
      });

      it("should treat ttlMs of 0 as already expired (not stored)", async () => {
        await adapter.set("key1", "value1", 0);
        const result = await adapter.get<string>("key1");
        expect(result).toBeNull();
      });

      it("should treat negative ttlMs as already expired (not stored)", async () => {
        await adapter.set("key1", "value1", -1000);
        const result = await adapter.get<string>("key1");
        expect(result).toBeNull();
      });
    });

    describe("delete", () => {
      it("should remove an existing key", async () => {
        await adapter.set("key1", "value1");
        await adapter.delete("key1");
        const result = await adapter.get<string>("key1");
        expect(result).toBeNull();
      });

      it("should not throw when deleting a nonexistent key", async () => {
        await expect(adapter.delete("nonexistent")).resolves.not.toThrow();
      });

      it("should only delete the specified key", async () => {
        await adapter.set("key1", "value1");
        await adapter.set("key2", "value2");
        await adapter.delete("key1");
        const result1 = await adapter.get<string>("key1");
        const result2 = await adapter.get<string>("key2");
        expect(result1).toBeNull();
        expect(result2!.value).toBe("value2");
      });
    });

    describe("clear", () => {
      it("should remove all entries", async () => {
        await adapter.set("key1", "value1");
        await adapter.set("key2", "value2");
        await adapter.set("key3", "value3");
        await adapter.clear();
        expect(await adapter.get("key1")).toBeNull();
        expect(await adapter.get("key2")).toBeNull();
        expect(await adapter.get("key3")).toBeNull();
      });

      it("should not throw when clearing empty adapter", async () => {
        await expect(adapter.clear()).resolves.not.toThrow();
      });
    });

    describe("has", () => {
      it("should return false for missing key", async () => {
        expect(await adapter.has("nonexistent")).toBe(false);
      });

      it("should return true for present key", async () => {
        await adapter.set("key1", "value1");
        expect(await adapter.has("key1")).toBe(true);
      });

      it("should return false for expired key", async () => {
        await adapter.set("key1", "value1", 1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await adapter.has("key1")).toBe(false);
      });
    });

    describe("getTtl", () => {
      it("should return missing for nonexistent key", async () => {
        const result = await adapter.getTtl("nonexistent");
        expect(result).toEqual({ kind: "missing" });
      });

      it("should return permanent for key without TTL", async () => {
        await adapter.set("key1", "value1");
        const result = await adapter.getTtl("key1");
        expect(result).toEqual({ kind: "permanent" });
      });

      it("should return expiring with positive ttlMs for key with TTL", async () => {
        await adapter.set("key1", "value1", 60000);
        const result = await adapter.getTtl("key1");
        expect(result.kind).toBe("expiring");
        if (result.kind === "expiring") {
          expect(result.ttlMs).toBeGreaterThan(0);
          expect(result.ttlMs).toBeLessThanOrEqual(60000);
        }
      });

      it("should return missing for expired key", async () => {
        await adapter.set("key1", "value1", 1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const result = await adapter.getTtl("key1");
        expect(result).toEqual({ kind: "missing" });
      });
    });

    if (supportsKeys) {
      describe("keys", () => {
        it("should return empty array when no keys exist", async () => {
          const result = await adapter.keys();
          expect(result).toEqual([]);
        });

        it("should return all stored keys", async () => {
          await adapter.set("key1", "value1");
          await adapter.set("key2", "value2");
          const result = await adapter.keys();
          expect(result.sort()).toEqual(["key1", "key2"]);
        });

        it("should reflect keys after delete", async () => {
          await adapter.set("key1", "value1");
          await adapter.set("key2", "value2");
          await adapter.delete("key1");
          const result = await adapter.keys();
          expect(result).toEqual(["key2"]);
        });
      });
    }

    describe("mget", () => {
      it("should return correct entries for hits", async () => {
        await adapter.set("a", 1);
        await adapter.set("b", 2);
        const result = await adapter.mget<number>(["a", "b"]);
        expect(result.get("a")!.value).toBe(1);
        expect(result.get("b")!.value).toBe(2);
      });

      it("should omit missing keys from the Map", async () => {
        await adapter.set("a", 1);
        const result = await adapter.mget<number>(["a", "missing"]);
        expect(result.has("a")).toBe(true);
        expect(result.has("missing")).toBe(false);
      });

      it("should return empty Map for empty key list", async () => {
        const result = await adapter.mget([]);
        expect(result.size).toBe(0);
      });
    });

    describe("mset", () => {
      it("should store multiple entries retrievable via get", async () => {
        await adapter.mset([
          { key: "a", value: 1 },
          { key: "b", value: 2 },
        ]);
        const a = await adapter.get<number>("a");
        const b = await adapter.get<number>("b");
        expect(a!.value).toBe(1);
        expect(b!.value).toBe(2);
      });

      it("should respect per-entry TTL", async () => {
        await adapter.mset([
          { key: "a", value: 1, ttlMs: 60000 },
          { key: "b", value: 2 },
        ]);
        const a = await adapter.get<number>("a");
        const b = await adapter.get<number>("b");
        expect(a!.expiresAt).toBeTypeOf("number");
        expect(b!.expiresAt).toBeNull();
      });

      it("should treat ttlMs of 0 as already expired (not stored)", async () => {
        await adapter.mset([
          { key: "a", value: 1, ttlMs: 0 },
          { key: "b", value: 2 },
        ]);
        expect(await adapter.get("a")).toBeNull();
        expect((await adapter.get<number>("b"))!.value).toBe(2);
      });

      it("should treat negative ttlMs as already expired (not stored)", async () => {
        await adapter.mset([
          { key: "a", value: 1, ttlMs: -1000 },
          { key: "b", value: 2 },
        ]);
        expect(await adapter.get("a")).toBeNull();
        expect((await adapter.get<number>("b"))!.value).toBe(2);
      });

      it("should be a no-op for empty entry list", async () => {
        await expect(adapter.mset([])).resolves.not.toThrow();
      });

      it("should overwrite existing values", async () => {
        await adapter.set("a", 1);
        await adapter.mset([{ key: "a", value: 99 }]);
        const a = await adapter.get<number>("a");
        expect(a!.value).toBe(99);
      });
    });

    describe("mdel", () => {
      it("should remove all specified keys", async () => {
        await adapter.set("a", 1);
        await adapter.set("b", 2);
        await adapter.set("c", 3);
        await adapter.mdel(["a", "c"]);
        expect(await adapter.get("a")).toBeNull();
        expect(await adapter.get("b")).not.toBeNull();
        expect(await adapter.get("c")).toBeNull();
      });

      it("should not throw for nonexistent keys", async () => {
        await expect(adapter.mdel(["nonexistent"])).resolves.not.toThrow();
      });
    });

    describe("flushAll", () => {
      it("should remove all entries", async () => {
        await adapter.set("key1", "value1");
        await adapter.set("key2", "value2");
        await adapter.flushAll();
        expect(await adapter.get("key1")).toBeNull();
        expect(await adapter.get("key2")).toBeNull();
      });

      it("should not throw when backend is empty", async () => {
        await expect(adapter.flushAll()).resolves.not.toThrow();
      });
    });
  });
}

// Run contract tests against MemoryAdapter
runAdapterContractTests("MemoryAdapter", () => new MemoryAdapter());
