import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemcacheAdapter } from "../../src/memcache-adapter.js";
import type { Client } from "memjs";

function createMockClient(): Client {
  const store = new Map<string, { value: Buffer; expiresAt: number | null }>();

  return {
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return { value: null, flags: null };
      if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
        store.delete(key);
        return { value: null, flags: null };
      }
      return { value: entry.value, flags: null };
    }),
    set: vi.fn(
      async (key: string, value: string, options?: { expires?: number }) => {
        const expiresSec = options?.expires ?? 0;
        const expiresAt =
          expiresSec > 0 ? Date.now() + expiresSec * 1000 : null;
        store.set(key, { value: Buffer.from(value), expiresAt });
        return true;
      },
    ),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
      return true;
    }),
    flush: vi.fn(async () => {
      store.clear();
      return true;
    }),
  } as unknown as Client;
}

describe("MemcacheAdapter", () => {
  let mockClient: Client;
  let adapter: MemcacheAdapter;

  beforeEach(() => {
    mockClient = createMockClient();
    adapter = new MemcacheAdapter({ client: mockClient });
  });

  describe("name", () => {
    it('should return "memcache"', () => {
      expect(adapter.name).toBe("memcache");
    });
  });

  describe("get", () => {
    it("should return null on cache miss", async () => {
      const result = await adapter.get("nonexistent");
      expect(result).toBeNull();
    });

    it("should return CacheEntry on cache hit", async () => {
      await adapter.set("key1", "hello");
      const result = await adapter.get<string>("key1");
      expect(result).not.toBeNull();
      expect(result!.value).toBe("hello");
    });

    it("should deserialize JSON-stored values", async () => {
      await adapter.set("key1", { foo: "bar" });
      const result = await adapter.get<{ foo: string }>("key1");
      expect(result!.value).toEqual({ foo: "bar" });
    });
  });

  describe("set", () => {
    it("should store value with JSON serialization", async () => {
      await adapter.set("key1", "value1");
      expect(mockClient.set).toHaveBeenCalledWith(
        "key1",
        expect.stringContaining('"value":"value1"'),
        { expires: 0 },
      );
    });

    it("should convert TTL from ms to seconds", async () => {
      await adapter.set("key1", "value1", 5000);
      expect(mockClient.set).toHaveBeenCalledWith("key1", expect.any(String), {
        expires: 5,
      });
    });

    it("should ceil fractional TTL seconds", async () => {
      await adapter.set("key1", "value1", 1500);
      expect(mockClient.set).toHaveBeenCalledWith("key1", expect.any(String), {
        expires: 2,
      });
    });
  });

  describe("delete", () => {
    it("should call delete on the memjs client", async () => {
      await adapter.delete("key1");
      expect(mockClient.delete).toHaveBeenCalledWith("key1");
    });
  });

  describe("clear", () => {
    it("should call flush on the memjs client", async () => {
      await adapter.clear();
      expect(mockClient.flush).toHaveBeenCalled();
    });
  });

  describe("flushAll", () => {
    it("should call flush on the memjs client", async () => {
      await adapter.flushAll();
      expect(mockClient.flush).toHaveBeenCalled();
    });
  });

  describe("keys", () => {
    it("should throw because Memcached does not support key enumeration", async () => {
      await expect(adapter.keys()).rejects.toThrow(
        "does not support key enumeration",
      );
    });
  });

  describe("prefix support", () => {
    it("should prepend prefix to all keys", async () => {
      const prefixed = new MemcacheAdapter({
        client: mockClient,
        prefix: "myapp:",
      });

      await prefixed.set("key1", "value1");
      expect(mockClient.set).toHaveBeenCalledWith(
        "myapp:key1",
        expect.any(String),
        expect.any(Object),
      );
    });

    it("should prepend prefix when getting", async () => {
      const prefixed = new MemcacheAdapter({
        client: mockClient,
        prefix: "cache:",
      });

      await prefixed.get("key1");
      expect(mockClient.get).toHaveBeenCalledWith("cache:key1");
    });

    it("should prepend prefix when deleting", async () => {
      const prefixed = new MemcacheAdapter({
        client: mockClient,
        prefix: "cache:",
      });

      await prefixed.delete("key1");
      expect(mockClient.delete).toHaveBeenCalledWith("cache:key1");
    });
  });

  describe("defaultTtlMs", () => {
    it("should use defaultTtlMs when no ttlMs is passed", async () => {
      const a = new MemcacheAdapter({
        client: mockClient,
        defaultTtlMs: 5000,
      });

      await a.set("key1", "value1");
      expect(mockClient.set).toHaveBeenCalledWith("key1", expect.any(String), {
        expires: 5,
      });
    });

    it("should use defaultTtlMs over caller-provided ttlMs", async () => {
      const a = new MemcacheAdapter({
        client: mockClient,
        defaultTtlMs: 5000,
      });

      await a.set("key1", "value1", 60000);
      expect(mockClient.set).toHaveBeenCalledWith("key1", expect.any(String), {
        expires: 5,
      });
    });
  });
});
