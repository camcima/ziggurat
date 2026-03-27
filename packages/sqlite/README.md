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
    new MemoryAdapter({ defaultTtlMs: 30_000 }),       // L1: fast, volatile
    new SQLiteAdapter({                                  // L2: persistent
      db,
      defaultTtlMs: 120_000,
    }),
  ],
});

const user = await cache.wrap(`user:${id}`, async () =>
  api.getUser(id),
);
```

## Options

```ts
interface SQLiteAdapterOptions {
  db: Database;              // better-sqlite3 database instance
  defaultTtlMs?: number;    // Default TTL in milliseconds
  tableName?: string;        // Table name (default: "cache")
}
```

## Requirements

- `better-sqlite3` >= 11.0.0 (peer dependency)

## Documentation

See the [SQLite Adapter guide](https://github.com/camcima/ziggurat/blob/main/docs/sqlite-adapter.md) for configuration and use cases.

## License

MIT
