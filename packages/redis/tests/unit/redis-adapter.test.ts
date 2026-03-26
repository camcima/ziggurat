import { describe, it, expect, beforeEach, vi } from "vitest";
import { RedisAdapter } from "../../src/redis-adapter.js";
import type { Redis } from "ioredis";

function createMockRedis(): Redis {
  const store = new Map<string, string>();
  const ttls = new Map<string, number>();

  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    psetex: vi.fn(async (key: string, ms: number, value: string) => {
      store.set(key, value);
      ttls.set(key, Date.now() + ms);
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys.flat()) {
        store.delete(key);
      }
      return keys.flat().length;
    }),
    scan: vi.fn(async (_cursor: string, _match: string, pattern: string) => {
      const prefix = pattern.replaceAll("*", "");
      const matching = Array.from(store.keys()).filter((k) =>
        k.startsWith(prefix),
      );
      return ["0", matching];
    }),
    flushdb: vi.fn(async () => {
      store.clear();
      ttls.clear();
      return "OK";
    }),
    pipeline: vi.fn(() => {
      const commands: Array<() => [Error | null, unknown]> = [];
      const pipe = {
        get: vi.fn((key: string) => {
          commands.push(() => {
            const val = store.get(key) ?? null;
            return [null, val];
          });
          return pipe;
        }),
        set: vi.fn((key: string, value: string) => {
          commands.push(() => {
            store.set(key, value);
            return [null, "OK"];
          });
          return pipe;
        }),
        psetex: vi.fn((key: string, ms: number, value: string) => {
          commands.push(() => {
            store.set(key, value);
            ttls.set(key, Date.now() + ms);
            return [null, "OK"];
          });
          return pipe;
        }),
        del: vi.fn((...keys: string[]) => {
          commands.push(() => {
            for (const key of keys.flat()) {
              store.delete(key);
            }
            return [null, keys.flat().length];
          });
          return pipe;
        }),
        exec: vi.fn(async () => {
          return commands.map((cmd) => cmd());
        }),
      };
      return pipe;
    }),
  } as unknown as Redis;
}

describe("RedisAdapter", () => {
  let mockRedis: Redis;
  let adapter: RedisAdapter;

  beforeEach(() => {
    mockRedis = createMockRedis();
    adapter = new RedisAdapter({ client: mockRedis });
  });

  describe("name", () => {
    it('should return "redis"', () => {
      expect(adapter.name).toBe("redis");
    });
  });

  describe("get", () => {
    it("should return null on cache miss", async () => {
      const result = await adapter.get("nonexistent");
      expect(result).toBeNull();
    });

    it("should return CacheEntry on cache hit", async () => {
      const entry = JSON.stringify({ value: "hello", expiresAt: null });
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(entry);

      const result = await adapter.get<string>("key1");
      expect(result).not.toBeNull();
      expect(result!.value).toBe("hello");
      expect(result!.expiresAt).toBeNull();
    });

    it("should deserialize JSON-stored CacheEntry", async () => {
      const expiresAt = Date.now() + 60000;
      const entry = JSON.stringify({ value: { foo: "bar" }, expiresAt });
      (mockRedis.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(entry);

      const result = await adapter.get<{ foo: string }>("key1");
      expect(result!.value).toEqual({ foo: "bar" });
      expect(result!.expiresAt).toBe(expiresAt);
    });
  });

  describe("set", () => {
    it("should store JSON-serialized CacheEntry without TTL", async () => {
      await adapter.set("key1", "value1");
      expect(mockRedis.set).toHaveBeenCalledWith(
        "key1",
        expect.stringContaining('"value":"value1"'),
      );
    });

    it("should use PSETEX when TTL is provided", async () => {
      await adapter.set("key1", "value1", 5000);
      expect(mockRedis.psetex).toHaveBeenCalledWith(
        "key1",
        5000,
        expect.stringContaining('"value":"value1"'),
      );
    });

    it("should serialize complex objects", async () => {
      await adapter.set("key1", { nested: { data: [1, 2] } });
      const call = (mockRedis.set as ReturnType<typeof vi.fn>).mock.calls[0];
      const stored = JSON.parse(call[1] as string);
      expect(stored.value).toEqual({ nested: { data: [1, 2] } });
    });
  });

  describe("delete", () => {
    it("should call del on the redis client", async () => {
      await adapter.delete("key1");
      expect(mockRedis.del).toHaveBeenCalledWith("key1");
    });
  });

  describe("clear", () => {
    it("should scan for keys matching the prefix and delete them", async () => {
      await adapter.clear();
      expect(mockRedis.scan).toHaveBeenCalled();
    });
  });

  describe("defaultTtlMs", () => {
    it("should use defaultTtlMs when no ttlMs is passed to set", async () => {
      const a = new RedisAdapter({
        client: mockRedis,
        defaultTtlMs: 5000,
      });

      await a.set("key1", "value1");
      expect(mockRedis.psetex).toHaveBeenCalledWith(
        "key1",
        5000,
        expect.any(String),
      );
      expect(mockRedis.set).not.toHaveBeenCalled();
    });

    it("should use defaultTtlMs over caller-provided ttlMs", async () => {
      const a = new RedisAdapter({
        client: mockRedis,
        defaultTtlMs: 5000,
      });

      await a.set("key1", "value1", 60000);
      // Should use adapter's 5000ms, not caller's 60000ms
      expect(mockRedis.psetex).toHaveBeenCalledWith(
        "key1",
        5000,
        expect.any(String),
      );
    });

    it("should fall back to caller ttlMs when no defaultTtlMs", async () => {
      await adapter.set("key1", "value1", 3000);
      expect(mockRedis.psetex).toHaveBeenCalledWith(
        "key1",
        3000,
        expect.any(String),
      );
    });

    it("should use SET (no expiry) when neither defaultTtlMs nor ttlMs", async () => {
      await adapter.set("key1", "value1");
      expect(mockRedis.set).toHaveBeenCalled();
      expect(mockRedis.psetex).not.toHaveBeenCalled();
    });
  });

  describe("keys", () => {
    it("should use SCAN with prefix pattern", async () => {
      const prefixedAdapter = new RedisAdapter({
        client: mockRedis,
        prefix: "myapp:",
      });
      await prefixedAdapter.keys();
      expect(mockRedis.scan).toHaveBeenCalledWith(
        "0",
        "MATCH",
        "myapp:*",
        "COUNT",
        100,
      );
    });

    it("should strip prefix from returned keys", async () => {
      const prefixedAdapter = new RedisAdapter({
        client: mockRedis,
        prefix: "myapp:",
      });
      (mockRedis.scan as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        "0",
        ["myapp:key1", "myapp:key2"],
      ]);
      const result = await prefixedAdapter.keys();
      expect(result).toEqual(["key1", "key2"]);
    });
  });

  describe("mget", () => {
    it("should use pipeline for batch get", async () => {
      await adapter.set("a", "val-a");
      await adapter.set("b", "val-b");
      const result = await adapter.mget<string>(["a", "b"]);
      expect(result.size).toBe(2);
      expect(mockRedis.pipeline).toHaveBeenCalled();
    });

    it("should return empty Map for empty keys", async () => {
      const result = await adapter.mget([]);
      expect(result.size).toBe(0);
    });

    it("should return successful entries and skip errored pipeline slots", async () => {
      const entry = JSON.stringify({ value: "ok", expiresAt: null });
      const failingRedis = createMockRedis();
      const failingAdapter = new RedisAdapter({ client: failingRedis });
      const origPipeline = failingRedis.pipeline as ReturnType<typeof vi.fn>;
      origPipeline.mockReturnValueOnce({
        get: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([
          [new Error("redis read failed"), null],
          [null, entry],
        ]),
      });
      const result = await failingAdapter.mget<string>(["a", "b"]);
      // "a" errored, "b" succeeded — partial result returned
      expect(result.has("a")).toBe(false);
      expect(result.get("b")!.value).toBe("ok");
    });
  });

  describe("mset", () => {
    it("should use pipeline for batch set", async () => {
      await adapter.mset([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
      expect(mockRedis.pipeline).toHaveBeenCalled();
    });

    it("should skip entries with ttlMs <= 0", async () => {
      await adapter.mset([
        { key: "a", value: 1, ttlMs: 0 },
        { key: "b", value: 2 },
      ]);
      const result = await adapter.mget<number>(["a", "b"]);
      expect(result.has("a")).toBe(false);
      expect(result.get("b")!.value).toBe(2);
    });

    it("should throw when pipeline returns command errors", async () => {
      const failingRedis = createMockRedis();
      const failingAdapter = new RedisAdapter({ client: failingRedis });
      const origPipeline = failingRedis.pipeline as ReturnType<typeof vi.fn>;
      origPipeline.mockReturnValueOnce({
        set: vi.fn().mockReturnThis(),
        psetex: vi.fn().mockReturnThis(),
        exec: vi
          .fn()
          .mockResolvedValue([[new Error("redis write failed"), null]]),
      });
      await expect(
        failingAdapter.mset([{ key: "a", value: 1 }]),
      ).rejects.toThrow("pipeline command(s) failed");
    });

    it("should be a no-op for empty entries", async () => {
      await adapter.mset([]);
      // pipeline should not be called for empty entries
    });
  });

  describe("mdel", () => {
    it("should call DEL with all prefixed keys", async () => {
      const prefixedAdapter = new RedisAdapter({
        client: mockRedis,
        prefix: "ns:",
      });
      await prefixedAdapter.mdel(["a", "b"]);
      expect(mockRedis.del).toHaveBeenCalledWith("ns:a", "ns:b");
    });

    it("should be a no-op for empty keys", async () => {
      await adapter.mdel([]);
    });
  });

  describe("flushAll", () => {
    it("should call FLUSHDB on the redis client", async () => {
      await adapter.flushAll();
      expect(mockRedis.flushdb).toHaveBeenCalled();
    });
  });

  describe("prefix support", () => {
    it("should prepend prefix to all keys", async () => {
      const prefixedAdapter = new RedisAdapter({
        client: mockRedis,
        prefix: "myapp:",
      });

      await prefixedAdapter.set("key1", "value1");
      expect(mockRedis.set).toHaveBeenCalledWith(
        "myapp:key1",
        expect.any(String),
      );
    });

    it("should prepend prefix when getting", async () => {
      const prefixedAdapter = new RedisAdapter({
        client: mockRedis,
        prefix: "cache:",
      });

      await prefixedAdapter.get("key1");
      expect(mockRedis.get).toHaveBeenCalledWith("cache:key1");
    });

    it("should prepend prefix when deleting", async () => {
      const prefixedAdapter = new RedisAdapter({
        client: mockRedis,
        prefix: "cache:",
      });

      await prefixedAdapter.delete("key1");
      expect(mockRedis.del).toHaveBeenCalledWith("cache:key1");
    });
  });
});
