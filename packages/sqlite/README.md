# @ziggurat-cache/sqlite

SQLite adapter for the [Ziggurat](https://github.com/camcima/ziggurat) multi-layer cache. Provides persistent local caching that survives process restarts.

## Installation

```bash
npm install @ziggurat-cache/core @ziggurat-cache/sqlite better-sqlite3
```

## Usage

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";
import { SQLiteAdapter } from "@ziggurat-cache/sqlite";
import Database from "better-sqlite3";

const db = new Database("cache.db");

const cache = new CacheManager({
  layers: [
    new MemoryAdapter({ defaultTtlMs: 30_000 }), // L1: fast, volatile
    new SQLiteAdapter({
      // L2: persistent
      db,
      defaultTtlMs: 120_000,
    }),
  ],
});

const user = await cache.wrap(`user:${id}`, async () => api.getUser(id));
```

## Options

```ts
interface SQLiteAdapterOptions {
  db: Database; // better-sqlite3 database instance
  defaultTtlMs?: number; // Fallback TTL when a call passes none
  maxTtlMs?: number; // Upper bound applied to every entry
  tableName?: string; // Table name (default: "ziggurat_cache")
  namespace?: string; // Key namespace within the table (default: "")
  busyTimeoutMs?: number; // Wait for a competing writer (default: 5000)
}
```

## Requirements

- `better-sqlite3` >= 11.0.0 (peer dependency)

## Documentation

See the [SQLite Adapter guide](https://github.com/camcima/ziggurat/blob/main/docs/sqlite-adapter.md) for configuration and use cases.

## License

MIT
