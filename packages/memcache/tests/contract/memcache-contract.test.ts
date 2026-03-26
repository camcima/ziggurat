import { vi } from "vitest";
import { runAdapterContractTests } from "../../../core/tests/contract/adapter-contract.test.js";
import { MemcacheAdapter } from "../../src/memcache-adapter.js";
import type { Client } from "memjs";

/**
 * In-memory mock of a memjs Client for contract testing.
 */
function createMockMemjsClient(): Client {
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

// Skip keys test — Memcached protocol does not support key enumeration
runAdapterContractTests(
  "MemcacheAdapter",
  () => new MemcacheAdapter({ client: createMockMemjsClient() }),
  { supportsKeys: false },
);
