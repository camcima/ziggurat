# Custom Adapters

Ziggurat's adapter interface is intentionally minimal. Any storage backend — a database, a file system, a remote API — can be wrapped in a `CacheAdapter` and plugged into the layer stack.

## Extend `BaseCacheAdapter`

The full `CacheAdapter` interface has twelve members (`has`, `getTtl`, `keys`, `mget`, `mset`, `mdel`, `flushAll`, and a `ttlPolicy` accessor on top of the four core methods). `BaseCacheAdapter` implements all of them in terms of four, so that is what you extend:

```ts
import { BaseCacheAdapter } from "@ziggurat-cache/core";
import type { CacheEntry } from "@ziggurat-cache/core";

// You implement these four; BaseCacheAdapter derives the rest.
abstract class BaseCacheAdapter {
  abstract readonly name: string;
  abstract get<T>(key: string): Promise<CacheEntry<T> | null>;
  abstract set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  abstract delete(key: string): Promise<void>;
  abstract clear(): Promise<void>;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
}
```

Implementing the bare `CacheAdapter` interface directly is supported, but then all twelve members are yours to write — and a layer with no `ttlPolicy` receives the source entry's remaining lifetime on backfill rather than getting its own policy applied.

## Implementing an Adapter

Here's a complete example of a SQLite adapter:

```ts
import { BaseCacheAdapter } from "@ziggurat-cache/core";
import type { AdapterTtlOptions, CacheEntry } from "@ziggurat-cache/core";
import Database from "better-sqlite3";

export interface SqliteAdapterOptions extends AdapterTtlOptions {
  filePath: string;
}

export class SqliteAdapter extends BaseCacheAdapter {
  readonly name = "sqlite";
  private db: Database.Database;

  constructor(options: SqliteAdapterOptions) {
    // Passing TTL options up is what populates `ttlPolicy` and `resolveTtl`.
    super(options);
    this.db = new Database(options.filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER
      )
    `);
  }

  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const row = this.db
      .prepare("SELECT value, expires_at FROM cache WHERE key = ?")
      .get(key) as { value: string; expires_at: number | null } | undefined;

    if (!row) return null;

    // Check expiration
    if (row.expires_at !== null && Date.now() >= row.expires_at) {
      this.db.prepare("DELETE FROM cache WHERE key = ?").run(key);
      return null;
    }

    return {
      value: JSON.parse(row.value) as T,
      expiresAt: row.expires_at,
    };
  }

  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    // undefined is never stored — every adapter treats it as a no-op write.
    if (value === undefined) return;
    // resolveTtl applies defaultTtlMs and maxTtlMs from the options you
    // passed to super(); an explicit ttlMs wins over defaultTtlMs.
    const effectiveTtl = this.resolveTtl(ttlMs);
    if (effectiveTtl !== undefined && effectiveTtl <= 0) return; // already expired
    const expiresAt =
      effectiveTtl !== undefined ? Date.now() + effectiveTtl : null;
    this.db
      .prepare(
        "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
      )
      .run(key, JSON.stringify(value), expiresAt);
  }

  async delete(key: string): Promise<void> {
    this.db.prepare("DELETE FROM cache WHERE key = ?").run(key);
  }

  async clear(): Promise<void> {
    this.db.exec("DELETE FROM cache");
  }
}
```

## Key Requirements

### 1. Return `CacheEntry<T>` from `get`

The `get` method must return `{ value, expiresAt }` or `null`. The `expiresAt` field is a Unix timestamp in milliseconds, or `null` for entries that never expire.

The CacheManager reads `expiresAt` to bound backfills: a copy written into a higher layer gets that layer's own `defaultTtlMs`, capped by your entry's remaining lifetime, so it never outlives the entry it came from. Returning `null` means the higher layer is free to apply its own policy with nothing to cap it.

### 2. Handle Expiration

Your adapter should check `expiresAt` on read and treat expired entries as misses. You can clean up expired entries lazily (on `get`) or eagerly (via a background process) — Ziggurat doesn't prescribe the approach.

### 3. TTL is in Milliseconds

The `ttlMs` parameter in `set` is a **duration** in milliseconds. Convert it to an absolute timestamp for storage:

```ts
const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : null;
```

### 4. `clear` Should Only Clear Your Keys

If your storage is shared with other systems, `clear` should only remove entries managed by your adapter — not everything in the database. Use a prefix, namespace, or dedicated table.

### 5. Methods Must Be Async

All methods return `Promise`. Even if your implementation is synchronous (like the built-in `MemoryAdapter`), the methods must be declared `async` or return resolved promises.

### 6. `undefined` Is Never Stored

`set(key, undefined)` is a no-op on every built-in adapter: nothing is written, the key reads as absent, and any existing value under it is left alone. Follow the same rule so behavior does not change with layer order.

### 7. Reads Should Not Delete Other People's Keys

Cleaning up expired or corrupt entries on read is fine when the rows are unambiguously yours (the SQLite adapter does it, guarded so a concurrent writer is never clobbered). When the backend is shared and scoped only by a key prefix — Redis, Memcached — the built-in adapters report a miss and leave the key alone. The next `set()` replaces it.

## Using Your Adapter

Once implemented, use it like any built-in adapter:

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";
import { SqliteAdapter } from "./sqlite-adapter";

const cache = new CacheManager({
  layers: [
    new MemoryAdapter(), // L1: fast
    new SqliteAdapter("./cache.db"), // L2: persistent
  ],
});
```

## Testing with Contract Tests

Ziggurat validates every built-in adapter against a shared contract suite (`packages/core/tests/contract/adapter-contract.test.ts`), which is how the adapters are kept behaviorally interchangeable. It covers:

- `get` returns `null` on a miss
- `get` returns a `CacheEntry` with correct `value` and `expiresAt`
- `set` stores and overwrites values, and treats `undefined` as a no-op
- `set` with TTL sets correct `expiresAt`; `ttlMs <= 0` is not stored
- TTL expiration removes entries
- `delete` removes a specific key, `clear` removes all keys
- `mget`/`mset`/`mdel` batch semantics, including skipping `undefined` values
- Various value types (strings, numbers, objects, booleans, null)

> **Note:** the suite is not published on npm yet — it lives in the repository and is imported by relative path from the adapter packages, so it is available to adapters developed inside this repo but not to external ones. Packaging it as a reusable test kit is planned; until then, the list above is the behavior an external adapter should reproduce in its own tests.

If your adapter satisfies these behaviors, it is compatible with the CacheManager.
