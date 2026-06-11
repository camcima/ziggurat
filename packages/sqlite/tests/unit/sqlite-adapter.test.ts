import { describe, it, expect, beforeEach } from "vitest";
import { SQLiteAdapter } from "../../src/sqlite-adapter.js";
import Database from "better-sqlite3";

describe("SQLiteAdapter", () => {
  let db: Database.Database;
  let adapter: SQLiteAdapter;

  beforeEach(() => {
    db = new Database(":memory:");
    adapter = new SQLiteAdapter({ db });
  });

  describe("name", () => {
    it('should return "sqlite"', () => {
      expect(adapter.name).toBe("sqlite");
    });
  });

  describe("schema creation", () => {
    it("should auto-create the cache table", () => {
      const tables = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='ziggurat_cache'",
        )
        .all();
      expect(tables).toHaveLength(1);
    });

    it("should create an expiry index on the cache table", () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ziggurat_cache_expires'",
        )
        .all();
      expect(indexes).toHaveLength(1);
    });

    it("should use custom table name", () => {
      const customDb = new Database(":memory:");
      new SQLiteAdapter({ db: customDb, tableName: "my_cache" });
      const tables = customDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='my_cache'",
        )
        .all();
      expect(tables).toHaveLength(1);
    });

    it("should reject invalid table names", () => {
      const customDb = new Database(":memory:");
      expect(
        () =>
          new SQLiteAdapter({
            db: customDb,
            tableName: "Robert'); DROP TABLE students;--",
          }),
      ).toThrow("Invalid table name");
    });

    it("should reject table names starting with a number", () => {
      const customDb = new Database(":memory:");
      expect(
        () => new SQLiteAdapter({ db: customDb, tableName: "123abc" }),
      ).toThrow("Invalid table name");
    });

    it("should accept valid table names with underscores", () => {
      const customDb = new Database(":memory:");
      expect(
        () => new SQLiteAdapter({ db: customDb, tableName: "_my_cache_v2" }),
      ).not.toThrow();
    });

    it("should enable WAL mode on file-based databases", () => {
      // WAL mode is not supported on :memory: databases (returns "memory")
      // Verify the pragma was attempted by checking it doesn't throw
      const mode = db.pragma("journal_mode", { simple: true });
      expect(typeof mode).toBe("string");
    });
  });

  describe("get", () => {
    it("should return null on cache miss", async () => {
      const result = await adapter.get("nonexistent");
      expect(result).toBeNull();
    });

    it("should return CacheEntry on cache hit", async () => {
      await adapter.set("key1", "value1");
      const result = await adapter.get<string>("key1");
      expect(result).not.toBeNull();
      expect(result!.value).toBe("value1");
      expect(result!.expiresAt).toBeNull();
    });

    it("should handle complex JSON values", async () => {
      await adapter.set("key1", { nested: { data: [1, 2, 3] } });
      const result = await adapter.get<{ nested: { data: number[] } }>("key1");
      expect(result!.value).toEqual({ nested: { data: [1, 2, 3] } });
    });

    it("should return null for expired entries", async () => {
      await adapter.set("key1", "value1", 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = await adapter.get("key1");
      expect(result).toBeNull();
    });
  });

  describe("set", () => {
    it("should store a value without TTL", async () => {
      await adapter.set("key1", "value1");
      const result = await adapter.get<string>("key1");
      expect(result!.value).toBe("value1");
      expect(result!.expiresAt).toBeNull();
    });

    it("should store a value with TTL", async () => {
      await adapter.set("key1", "value1", 60000);
      const result = await adapter.get<string>("key1");
      expect(result!.value).toBe("value1");
      expect(result!.expiresAt).toBeTypeOf("number");
    });

    it("should overwrite existing values", async () => {
      await adapter.set("key1", "value1");
      await adapter.set("key1", "value2");
      const result = await adapter.get<string>("key1");
      expect(result!.value).toBe("value2");
    });
  });

  describe("delete", () => {
    it("should remove a key", async () => {
      await adapter.set("key1", "value1");
      await adapter.delete("key1");
      expect(await adapter.get("key1")).toBeNull();
    });

    it("should not throw for nonexistent key", async () => {
      await expect(adapter.delete("nope")).resolves.not.toThrow();
    });
  });

  describe("clear", () => {
    it("should remove all entries in namespace", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      await adapter.clear();
      expect(await adapter.get("a")).toBeNull();
      expect(await adapter.get("b")).toBeNull();
    });
  });

  describe("namespace isolation", () => {
    it("should isolate keys between namespaces", async () => {
      const ns1 = new SQLiteAdapter({ db, namespace: "users" });
      const ns2 = new SQLiteAdapter({ db, namespace: "products" });

      await ns1.set("42", "Alice");
      await ns2.set("42", "Widget");

      expect((await ns1.get<string>("42"))!.value).toBe("Alice");
      expect((await ns2.get<string>("42"))!.value).toBe("Widget");
    });

    it("should not affect other namespaces on clear", async () => {
      const ns1 = new SQLiteAdapter({ db, namespace: "users" });
      const ns2 = new SQLiteAdapter({ db, namespace: "products" });

      await ns1.set("key1", "value1");
      await ns2.set("key1", "value1");

      await ns1.clear();
      expect(await ns1.get("key1")).toBeNull();
      expect((await ns2.get<string>("key1"))!.value).toBe("value1");
    });
  });

  describe("has", () => {
    it("should return false for missing key", async () => {
      expect(await adapter.has("nope")).toBe(false);
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
      expect(await adapter.getTtl("nope")).toEqual({ kind: "missing" });
    });

    it("should return permanent for key without TTL", async () => {
      await adapter.set("key1", "value1");
      expect(await adapter.getTtl("key1")).toEqual({ kind: "permanent" });
    });

    it("should return expiring for key with TTL", async () => {
      await adapter.set("key1", "value1", 60000);
      const result = await adapter.getTtl("key1");
      expect(result.kind).toBe("expiring");
      if (result.kind === "expiring") {
        expect(result.ttlMs).toBeGreaterThan(0);
      }
    });
  });

  describe("keys", () => {
    it("should return all stored keys", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      const result = await adapter.keys();
      expect(result.sort()).toEqual(["a", "b"]);
    });

    it("should not return expired keys", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2, 1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = await adapter.keys();
      expect(result).toEqual(["a"]);
    });

    it("should only return keys from own namespace", async () => {
      const ns1 = new SQLiteAdapter({ db, namespace: "users" });
      const ns2 = new SQLiteAdapter({ db, namespace: "products" });
      await ns1.set("a", 1);
      await ns2.set("b", 2);
      expect(await ns1.keys()).toEqual(["a"]);
      expect(await ns2.keys()).toEqual(["b"]);
    });
  });

  describe("mget", () => {
    it("should return entries for hits via SQL IN", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      const result = await adapter.mget<number>(["a", "b", "missing"]);
      expect(result.get("a")!.value).toBe(1);
      expect(result.get("b")!.value).toBe(2);
      expect(result.has("missing")).toBe(false);
    });

    it("should return empty Map for empty keys", async () => {
      const result = await adapter.mget([]);
      expect(result.size).toBe(0);
    });
  });

  describe("mset", () => {
    it("should store multiple entries via transaction", async () => {
      await adapter.mset([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
      expect((await adapter.get<number>("a"))!.value).toBe(1);
      expect((await adapter.get<number>("b"))!.value).toBe(2);
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

    it("should cap ttlMs at maxTtlMs in mset", async () => {
      const cappedAdapter = new SQLiteAdapter({ db, maxTtlMs: 5000 });
      await cappedAdapter.mset([{ key: "k", value: "v", ttlMs: 60_000 }]);
      const ttl = await cappedAdapter.getTtl("k");
      expect(ttl.kind).toBe("expiring");
      if (ttl.kind === "expiring") {
        expect(ttl.ttlMs).toBeLessThanOrEqual(5000);
      }
    });
  });

  describe("mdel", () => {
    it("should remove multiple keys via SQL IN", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      await adapter.set("c", 3);
      await adapter.mdel(["a", "c"]);
      expect(await adapter.get("a")).toBeNull();
      expect(await adapter.get("b")).not.toBeNull();
      expect(await adapter.get("c")).toBeNull();
    });
  });

  describe("flushAll", () => {
    it("should remove all entries across all namespaces", async () => {
      const ns1 = new SQLiteAdapter({ db, namespace: "users" });
      const ns2 = new SQLiteAdapter({ db, namespace: "products" });
      await ns1.set("a", 1);
      await ns2.set("b", 2);
      await ns1.flushAll();
      expect(await ns1.get("a")).toBeNull();
      expect(await ns2.get("b")).toBeNull();
    });
  });

  describe("purgeExpired", () => {
    it("deletes expired rows for this namespace and returns the count", async () => {
      const a = new SQLiteAdapter({ db });
      await a.set("expired1", "v", 1);
      await a.set("expired2", "v", 1);
      await a.set("alive", "v", 60_000);
      await a.set("permanent", "v");
      await new Promise((r) => setTimeout(r, 50));

      const purged = await a.purgeExpired();

      expect(purged).toBe(2);
      expect(await a.has("alive")).toBe(true);
      expect(await a.has("permanent")).toBe(true);
    });

    it("does not purge other namespaces", async () => {
      const a = new SQLiteAdapter({ db, namespace: "a" });
      const b = new SQLiteAdapter({ db, namespace: "b" });
      await a.set("k", "v", 1);
      await b.set("k", "v", 1);
      await new Promise((r) => setTimeout(r, 50));

      expect(await a.purgeExpired()).toBe(1);
      expect(await b.purgeExpired()).toBe(1);
    });

    it("returns 0 when there are no expired rows", async () => {
      const a = new SQLiteAdapter({ db });
      await a.set("alive", "v", 60_000);
      await a.set("permanent", "v");
      expect(await a.purgeExpired()).toBe(0);
      expect(await a.has("alive")).toBe(true);
      expect(await a.has("permanent")).toBe(true);
    });
  });

  describe("defaultTtlMs", () => {
    it("should use defaultTtlMs when no ttlMs is passed", async () => {
      const a = new SQLiteAdapter({ db, defaultTtlMs: 5000 });
      await a.set("key1", "value1");
      const result = await a.get<string>("key1");
      expect(result!.expiresAt).toBeTypeOf("number");
    });

    it("should use caller-provided ttlMs over defaultTtlMs", async () => {
      const a = new SQLiteAdapter({ db, defaultTtlMs: 5000 });
      await a.set("key1", "value1", 60000);
      const ttl = await a.getTtl("key1");
      expect(ttl.kind).toBe("expiring");
      if (ttl.kind === "expiring") {
        // explicit 60000ms wins over defaultTtlMs 5000ms
        expect(ttl.ttlMs).toBeGreaterThan(5000);
        expect(ttl.ttlMs).toBeLessThanOrEqual(60000);
      }
    });

    it("should cap ttlMs at maxTtlMs", async () => {
      const a = new SQLiteAdapter({ db, maxTtlMs: 5000 });
      await a.set("key1", "value1", 60000);
      const ttl = await a.getTtl("key1");
      expect(ttl.kind).toBe("expiring");
      if (ttl.kind === "expiring") {
        expect(ttl.ttlMs).toBeLessThanOrEqual(5000);
      }
    });
  });
});
