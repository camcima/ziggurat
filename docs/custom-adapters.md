# Custom Adapters

Ziggurat's adapter interface is intentionally minimal. Any storage backend — a database, a file system, a remote API — can be wrapped in a `CacheAdapter` and plugged into the layer stack.

## The `CacheAdapter` Interface

```ts
import type { CacheAdapter, CacheEntry } from "@ziggurat/core";

interface CacheAdapter {
  readonly name: string;
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
}
```

## Implementing an Adapter

Here's a complete example of a SQLite adapter:

```ts
import type { CacheAdapter, CacheEntry } from "@ziggurat/core";
import Database from "better-sqlite3";

export class SqliteAdapter implements CacheAdapter {
  readonly name = "sqlite";
  private db: Database.Database;

  constructor(filePath: string) {
    this.db = new Database(filePath);
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
    const expiresAt = ttlMs !== undefined ? Date.now() + ttlMs : null;
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

The CacheManager uses `expiresAt` to calculate the remaining TTL when backfilling higher layers. If you return `null` for `expiresAt`, backfilled entries will have no expiration.

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

## Using Your Adapter

Once implemented, use it like any built-in adapter:

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat/core";
import { SqliteAdapter } from "./sqlite-adapter";

const cache = new CacheManager({
  layers: [
    new MemoryAdapter(), // L1: fast
    new SqliteAdapter("./cache.db"), // L2: persistent
  ],
});
```

## Testing with Contract Tests

Ziggurat includes a shared contract test suite that verifies any adapter correctly implements the `CacheAdapter` interface. Use it to validate your custom adapter:

```ts
import { runAdapterContractTests } from "@ziggurat/core/tests/contract/adapter-contract.test";
import { SqliteAdapter } from "./sqlite-adapter";

runAdapterContractTests("SqliteAdapter", () => new SqliteAdapter(":memory:"));
```

The contract tests cover:

- `get` returns `null` on a miss
- `get` returns a `CacheEntry` with correct `value` and `expiresAt`
- `set` stores and overwrites values
- `set` with TTL sets correct `expiresAt`
- TTL expiration removes entries
- `delete` removes a specific key
- `clear` removes all keys
- Various value types (strings, numbers, objects, booleans, null)

If your adapter passes all contract tests, it is compatible with the CacheManager.
