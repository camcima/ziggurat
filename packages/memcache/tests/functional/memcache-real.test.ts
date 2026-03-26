import { describe, it, expect, beforeEach, afterAll } from "vitest";
import memjs from "memjs";
import { MemcacheAdapter } from "../../src/memcache-adapter.js";
import { runAdapterContractTests } from "../../../core/tests/contract/adapter-contract.test.js";

const MEMCACHE_URL = process.env.MEMCACHE_URL ?? "localhost:11211";

let client: memjs.Client;

beforeEach(() => {
  // Create a fresh client for each test to avoid state leaks
  client = memjs.Client.create(MEMCACHE_URL);
});

afterAll(() => {
  client.close();
});

// Run the shared contract test suite against a REAL Memcached instance
// Note: keys() is not supported by Memcached protocol
runAdapterContractTests(
  "MemcacheAdapter (real Memcached)",
  () => {
    const c = memjs.Client.create(MEMCACHE_URL);
    return new MemcacheAdapter({ client: c });
  },
  { supportsKeys: false },
);

describe("MemcacheAdapter functional tests (real Memcached)", () => {
  let adapter: MemcacheAdapter;

  beforeEach(async () => {
    adapter = new MemcacheAdapter({ client });
    await adapter.flushAll();
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
  });

  describe("TTL with real Memcached expiry", () => {
    it("should expire entries via Memcached TTL", async () => {
      // Memcached TTL is in seconds, minimum 1 second
      await adapter.set("ttl-key", "value", 1000);
      const before = await adapter.get<string>("ttl-key");
      expect(before!.value).toBe("value");

      // Wait for Memcached to expire the key
      await new Promise((resolve) => setTimeout(resolve, 2000));
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
      const adapter1 = new MemcacheAdapter({ client, prefix: "pfx1:" });
      const adapter2 = new MemcacheAdapter({ client, prefix: "pfx2:" });

      await adapter1.set("shared-key", "from-adapter1");
      await adapter2.set("shared-key", "from-adapter2");

      expect((await adapter1.get<string>("shared-key"))!.value).toBe(
        "from-adapter1",
      );
      expect((await adapter2.get<string>("shared-key"))!.value).toBe(
        "from-adapter2",
      );
    });
  });

  describe("batch operations", () => {
    it("should handle mget via individual gets", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      const result = await adapter.mget<number>(["a", "b", "missing"]);
      expect(result.get("a")!.value).toBe(1);
      expect(result.get("b")!.value).toBe(2);
      expect(result.has("missing")).toBe(false);
    });

    it("should handle mset via individual sets", async () => {
      await adapter.mset([
        { key: "x", value: 10 },
        { key: "y", value: 20 },
      ]);
      expect((await adapter.get<number>("x"))!.value).toBe(10);
      expect((await adapter.get<number>("y"))!.value).toBe(20);
    });

    it("should handle mdel via individual deletes", async () => {
      await adapter.set("a", 1);
      await adapter.set("b", 2);
      await adapter.mdel(["a"]);
      expect(await adapter.get("a")).toBeNull();
      expect((await adapter.get<number>("b"))!.value).toBe(2);
    });
  });

  describe("keys() limitation", () => {
    it("should throw when keys() is called", async () => {
      await expect(adapter.keys()).rejects.toThrow(
        "does not support key enumeration",
      );
    });
  });
});
