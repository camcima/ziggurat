# SQLite Adapter

The `@ziggurat-cache/sqlite` package provides a `SQLiteAdapter` that uses [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) to store cached values in a SQLite database. It's designed for persistent local caching that survives process restarts.

## Installation

```bash
npm install @ziggurat-cache/sqlite better-sqlite3
```

`better-sqlite3` is a peer dependency. You create and manage the database instance.

## Basic Setup

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";
import { SQLiteAdapter } from "@ziggurat-cache/sqlite";
import Database from "better-sqlite3";

const db = new Database("./cache.db");

const cache = new CacheManager({
  layers: [
    new MemoryAdapter({ defaultTtlMs: 30_000 }),
    new SQLiteAdapter({ db, defaultTtlMs: 3600_000 }),
  ],
});
```

## Configuration

| Property        | Type                | Default            | Description                                                                                                                                    |
| --------------- | ------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `db`            | `Database.Database` | _(required)_       | A better-sqlite3 database instance.                                                                                                            |
| `tableName`     | `string`            | `"ziggurat_cache"` | Name of the cache table.                                                                                                                       |
| `namespace`     | `string`            | `""`               | Namespace for key isolation within the same table.                                                                                             |
| `defaultTtlMs`  | `number`            | _none_             | Fallback TTL applied when no `ttlMs` is passed to `set`/`wrap`. An explicit `ttlMs` always wins. Use `maxTtlMs` to cap all TTLs for the layer. |
| `maxTtlMs`      | `number`            | _none_             | Upper bound applied to every entry's TTL — explicit TTLs, `defaultTtlMs`, and otherwise-permanent entries are all capped to this.              |
| `busyTimeoutMs` | `number`            | `5000`             | How long a blocked write waits for a competing writer before failing with `SQLITE_BUSY`. Set `0` to keep SQLite's no-wait default.             |

## Schema

The adapter auto-creates its table on construction:

```sql
CREATE TABLE IF NOT EXISTS ziggurat_cache (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (namespace, key)
);
```

- **WAL mode** is enabled for concurrent read performance.
- **Prepared statements** are cached and reused for all operations.
- Values are stored as JSON text; `expires_at` is a Unix timestamp in milliseconds.

The adapter sets `journal_mode = WAL`, `synchronous = NORMAL`, and `busy_timeout` (5s by default) on the database you pass in. WAL mode persists on the database file — use a dedicated database file for the cache if that matters.

## Concurrent Access

WAL mode lets readers and a writer work at the same time, and `busyTimeoutMs` makes a blocked writer wait its turn instead of failing immediately with `SQLITE_BUSY`.

Reads clean up as they go: a `get` that finds an expired or unparseable row deletes it. Those deletes are conditional on the row still being the one that was read (still expired, or still holding the same corrupt payload), so a writer that refreshed the key between the read and the delete is never clobbered.

## Namespace Isolation

Multiple adapters can share the same database and table with different namespaces:

```ts
const userCache = new SQLiteAdapter({ db, namespace: "users" });
const productCache = new SQLiteAdapter({ db, namespace: "products" });

// These are completely isolated from each other
await userCache.set("42", "Alice");
await productCache.set("42", "Widget");
```

`clear()` only removes entries in the adapter's namespace. `flushAll()` removes all entries across all namespaces.

> **Warning**: `clear()` removes only the current adapter's namespace, while `flushAll()` deletes ALL rows in the cache table across every namespace. Use `clear()` for per-namespace resets.

## Batch Operations

All batch operations use efficient SQL:

- **`mget`**: Chunked `SELECT ... WHERE key IN (...)` queries (900 keys per chunk, merged into one result) to stay under SQLite's bind-variable limit
- **`mset`**: Wrapped in a SQLite transaction for atomicity and performance
- **`mdel`**: Chunked `DELETE ... WHERE key IN (...)` statements (900 keys per chunk) executed atomically inside a single transaction to stay under SQLite's bind-variable limit

## Maintenance

- `purgeExpired(): Promise<number>` — Deletes expired rows for the adapter's namespace and returns the count; call periodically in long-running processes.

## Performance

SQLite with `better-sqlite3` is extremely fast for local caching:

- Synchronous API avoids async overhead (wrapped in `async` methods to satisfy the interface)
- Prepared statements are compiled once and reused
- WAL mode allows concurrent readers
- Transactions for batch writes provide 100x+ throughput improvement

## Persistence

Unlike memory-based caches, SQLite data survives process restarts. This makes it ideal for:

- CLI tools that cache API responses between runs
- Development servers that preserve cache across restarts
- Edge workers with local storage
- Fallback L3 layer behind memory + Redis
