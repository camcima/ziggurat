import { vi } from "vitest";
import { runAdapterContractTests } from "../../../core/tests/contract/adapter-contract.test.js";
import { RedisAdapter } from "../../src/redis-adapter.js";
import type { Redis } from "ioredis";

/**
 * Run contract tests against RedisAdapter using a mock Redis client.
 * In CI, these could be run against a real Redis instance via REDIS_URL.
 */
function createInMemoryRedis(): Redis {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  return {
    get: vi.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    }),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, { value, expiresAt: null });
      return "OK";
    }),
    psetex: vi.fn(async (key: string, ms: number, value: string) => {
      store.set(key, { value, expiresAt: Date.now() + ms });
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
      return "OK";
    }),
    pipeline: vi.fn(() => {
      const commands: Array<() => [Error | null, unknown]> = [];
      const pipe = {
        get: vi.fn((key: string) => {
          commands.push(() => {
            const entry = store.get(key);
            if (!entry) return [null, null];
            if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
              store.delete(key);
              return [null, null];
            }
            return [null, entry.value];
          });
          return pipe;
        }),
        set: vi.fn((key: string, value: string) => {
          commands.push(() => {
            store.set(key, { value, expiresAt: null });
            return [null, "OK"];
          });
          return pipe;
        }),
        psetex: vi.fn((key: string, ms: number, value: string) => {
          commands.push(() => {
            store.set(key, { value, expiresAt: Date.now() + ms });
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

runAdapterContractTests(
  "RedisAdapter",
  () => new RedisAdapter({ client: createInMemoryRedis() }),
);
