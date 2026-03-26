# API Reference

## `@ziggurat/core`

### `CacheManager`

The main orchestrator that manages an ordered stack of cache adapters.

```ts
import { CacheManager } from "@ziggurat/core";
```

#### Constructor

```ts
new CacheManager(options: CacheManagerOptions)
```

**`CacheManagerOptions`**:

| Property       | Type             | Default              | Description                                                                   |
| -------------- | ---------------- | -------------------- | ----------------------------------------------------------------------------- |
| `layers`       | `CacheAdapter[]` | _(required)_         | Ordered array of cache layers. L1 is index 0 (fastest).                       |
| `namespace`    | `string`         | _none_               | Prefix prepended to all keys as `namespace:key`. Useful for logical grouping. |
| `syncBackfill` | `boolean`        | `false`              | When `true`, waits for backfill to complete before returning.                 |
| `stampede`     | `StampedeConfig` | `{ coalesce: true }` | Stampede protection configuration.                                            |

**`StampedeConfig`**:

| Property   | Type      | Default | Description                                                 |
| ---------- | --------- | ------- | ----------------------------------------------------------- |
| `coalesce` | `boolean` | `true`  | Combine concurrent cache misses into a single factory call. |

#### Methods

##### `get<T>(key: string): Promise<CacheEntry<T> | null>`

Queries layers sequentially from L1 to L*n*. Returns the first hit and backfills higher layers. Returns `null` on a complete miss.

```ts
const entry = await cache.get<User>("user:42");
if (entry) {
  console.log(entry.value); // User
  console.log(entry.expiresAt); // number | null
}
```

##### `set<T>(key: string, value: T, ttlMs?: number): Promise<void>`

Writes the value to **all** layers. TTL is in milliseconds. Omit for no expiration.

```ts
await cache.set("user:42", userData, 300_000);
```

##### `delete(key: string): Promise<void>`

Removes the key from **all** layers.

```ts
await cache.delete("user:42");
```

##### `getLayers(): readonly CacheAdapter[]`

Returns the configured adapter layers in order (L1 at index 0). Each call returns a new array — mutations to the returned array do not affect the manager's internal state. The adapter references are the same objects passed to the constructor.

Use this to perform adapter-level operations like `clear()`, `flushAll()`, or `keys()` on individual layers:

```ts
const [l1, l2] = cache.getLayers();

// Clear a specific layer
await l1.clear();

// Clear all layers explicitly
for (const layer of cache.getLayers()) {
  await layer.clear();
}

// Get keys from a specific layer
const keys = await l2.keys();

// Flush a specific layer
await l2.flushAll();
```

> **Note**: Adapters returned by `getLayers()` do **not** apply the manager's namespace — they expose their raw API.

##### `wrap<T>(key: string, factory: () => Promise<T>, ttlMs?: number): Promise<T>`

The primary API. Checks the cache first. On a miss, calls the factory, caches the result across all layers, and returns it. Includes stampede protection via request coalescing.

```ts
const user = await cache.wrap(
  "user:42",
  async () => db.users.findById(42),
  300_000,
);
```

**Behavior**:

1. Check all layers sequentially (like `get`).
2. If found, return `entry.value`.
3. If not found and coalescing is enabled, check for an in-flight request for the same key. If one exists, attach to it.
4. Otherwise, call the factory, store the result via `set`, and return the value.
5. If the factory throws, the error propagates to all coalesced callers and the in-flight entry is cleaned up.

##### `del(key: string): Promise<void>`

Alias for `delete`. Convenience method for developers coming from Redis-style APIs.

##### `mget<T>(keys: string[]): Promise<Map<string, CacheEntry<T>>>`

Batch get across layers with backfill. Missing keys are absent from the returned Map. Layers are queried sequentially with a shrinking remaining set — keys found in L1 are not queried in L2.

```ts
const entries = await cache.mget<number>(["a", "b", "missing"]);
entries.get("a")?.value; // number
entries.has("missing"); // false
```

##### `mset<T>(entries: CacheSetEntry<T>[]): Promise<void>`

Batch set across all layers with optional per-entry TTL. Writes to all layers in parallel.

```ts
await cache.mset([
  { key: "a", value: 1, ttlMs: 60_000 },
  { key: "b", value: 2 },
]);
```

##### `mdel(keys: string[]): Promise<void>`

Batch delete across all layers.

```ts
await cache.mdel(["a", "b"]);
```

##### `getTtl(key: string): Promise<TtlResult>`

Returns TTL information from the first layer with a hit. Returns a discriminated union:

```ts
const result = await cache.getTtl("key");
switch (result.kind) {
  case "missing":
    break; // key not found
  case "permanent":
    break; // key exists, no expiration
  case "expiring": // key exists, expires in result.ttlMs ms
    console.log(result.ttlMs);
    break;
}
```

##### `has(key: string): Promise<boolean>`

Check existence across layers. Returns `true` on first hit.

---

### `CacheSetEntry<T>`

Input type for `mset` with optional per-entry TTL.

```ts
interface CacheSetEntry<T> {
  key: string;
  value: T;
  ttlMs?: number;
}
```

### `TtlResult`

Discriminated union returned by `getTtl`.

```ts
type TtlResult =
  | { kind: "missing" }
  | { kind: "permanent" }
  | { kind: "expiring"; ttlMs: number };
```

### `BaseCacheAdapter`

Abstract class that implements `CacheAdapter` with default implementations for all extended methods. New adapters should extend this class and only implement the 4 core methods: `get`, `set`, `delete`, `clear`.

```ts
import { BaseCacheAdapter } from "@ziggurat/core";
```

See [Custom Adapters](custom-adapters.md) for a guide on building your own.

---

### `MemoryAdapter`

In-process cache adapter backed by [`node-cache`](https://www.npmjs.com/package/node-cache).

```ts
import { MemoryAdapter } from "@ziggurat/core";
```

#### Constructor

```ts
new MemoryAdapter(options?: MemoryAdapterOptions)
```

**`MemoryAdapterOptions`**:

| Property       | Type     | Default | Description                                                                                            |
| -------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------ |
| `defaultTtlMs` | `number` | _none_  | Default TTL in milliseconds applied to all entries. Takes precedence over TTL passed via `set`/`wrap`. |

```ts
// Unbounded, no default TTL
const memory = new MemoryAdapter();

// 30-second default TTL
const memory = new MemoryAdapter({ defaultTtlMs: 30_000 });
```

#### Properties

| Property | Type     | Value      |
| -------- | -------- | ---------- |
| `name`   | `string` | `"memory"` |

#### Methods

Implements the full `CacheAdapter` interface including `has`, `getTtl`, `keys`, `mget`, `mset`, `mdel`, `flushAll`.

- Expired entries (past their TTL) are lazily cleaned up on `get`.
- Overrides `has`, `getTtl`, `keys`, and `flushAll` using native `node-cache` methods for better performance.

---

### `CacheEntry<T>`

The standard return type from adapter `get` methods.

```ts
interface CacheEntry<T> {
  value: T;
  expiresAt: number | null; // Unix timestamp in ms, or null for no expiration
}
```

---

### `CacheAdapter`

The contract every storage backend must implement.

```ts
interface CacheAdapter {
  readonly name: string;
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  has(key: string): Promise<boolean>;
  getTtl(key: string): Promise<TtlResult>;
  keys(): Promise<string[]>;
  mget<T>(keys: readonly string[]): Promise<Map<string, CacheEntry<T>>>;
  mset<T>(entries: readonly CacheSetEntry<T>[]): Promise<void>;
  mdel(keys: readonly string[]): Promise<void>;
  flushAll(): Promise<void>;
}
```

See [Custom Adapters](custom-adapters.md) for a guide on building your own. Extend `BaseCacheAdapter` for default implementations of all extended methods.

---

## `@ziggurat/redis`

### `RedisAdapter`

Cache adapter for Redis using `ioredis`. Stores values as JSON strings.

```ts
import { RedisAdapter } from "@ziggurat/redis";
```

#### Constructor

```ts
new RedisAdapter(options: RedisAdapterOptions)
```

**`RedisAdapterOptions`**:

| Property       | Type              | Default      | Description                                                                                            |
| -------------- | ----------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| `client`       | `Redis` (ioredis) | _(required)_ | A configured ioredis client instance.                                                                  |
| `prefix`       | `string`          | `""`         | Key prefix for infrastructure-level isolation. All keys are stored as `prefix + key`.                  |
| `defaultTtlMs` | `number`          | _none_       | Default TTL in milliseconds applied to all entries. Takes precedence over TTL passed via `set`/`wrap`. |

```ts
import Redis from "ioredis";

const adapter = new RedisAdapter({
  client: new Redis("redis://localhost:6379"),
  prefix: "myapp:",
  defaultTtlMs: 600_000, // 10-minute default TTL
});
```

#### Properties

| Property | Type     | Value     |
| -------- | -------- | --------- |
| `name`   | `string` | `"redis"` |

#### Methods

Implements the full `CacheAdapter` interface.

- **`get`**: Fetches the key from Redis, parses the JSON, and checks expiration. Returns `null` for missing or expired keys.
- **`set`**: Serializes the value as `{ value, expiresAt }` JSON. Uses `PSETEX` for entries with TTL, `SET` for entries without.
- **`delete`**: Deletes the prefixed key.
- **`clear`**: Scans for all keys matching the prefix pattern and deletes them using a pipeline. Pipeline command failures throw `AggregateError`.
- **`mget`**: Uses a pipeline for batch reads. Per-key read errors are skipped and the successful entries are returned — this means `mget()` may return a partial result map rather than rejecting the entire batch.
- **`mset`**: Uses a pipeline for batch writes. Entries with `ttlMs <= 0` are skipped. Pipeline command failures throw `AggregateError`.

See [Redis Adapter](redis-adapter.md) for detailed usage.

---

## `@ziggurat/nestjs`

### `ZigguratModule`

NestJS dynamic module that provides a `CacheManager` via dependency injection.

```ts
import { ZigguratModule } from "@ziggurat/nestjs";
```

#### `ZigguratModule.forRoot(options: CacheManagerOptions): DynamicModule`

Synchronous registration. Creates the `CacheManager` immediately.

```ts
@Module({
  imports: [
    ZigguratModule.forRoot({
      layers: [new MemoryAdapter()],
    }),
  ],
})
export class AppModule {}
```

The module is registered **globally** — the `CacheManager` is available for injection in any module without re-importing.

#### `ZigguratModule.forRootAsync(options: ZigguratModuleAsyncOptions): DynamicModule`

Asynchronous registration. Use when your cache configuration depends on other providers (e.g., `ConfigService`).

**`ZigguratModuleAsyncOptions`**:

| Property     | Type                                                               | Description                                |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------ |
| `imports`    | `any[]`                                                            | Modules to import (e.g., `ConfigModule`).  |
| `useFactory` | `(...args) => CacheManagerOptions \| Promise<CacheManagerOptions>` | Factory function that returns the options. |
| `inject`     | `any[]`                                                            | Providers to inject into the factory.      |

```ts
@Module({
  imports: [
    ZigguratModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        layers: [
          new MemoryAdapter({ defaultTtlMs: config.get("CACHE_DEFAULT_TTL") }),
          new RedisAdapter({ client: new Redis(config.get("REDIS_URL")) }),
        ],
      }),
    }),
  ],
})
export class AppModule {}
```

---

### `@Cached()` Decorator

Method decorator that transparently wraps a service method with `CacheManager.wrap()`.

```ts
import { Cached } from "@ziggurat/nestjs";
```

#### Signature

```ts
@Cached(options: CachedDecoratorOptions)
```

**`CachedDecoratorOptions`**:

| Property | Type                         | Description                                                              |
| -------- | ---------------------------- | ------------------------------------------------------------------------ |
| `key`    | `(...args: any[]) => string` | Function that receives the method's arguments and returns the cache key. |
| `ttlMs`  | `number`                     | _(optional)_ TTL in milliseconds.                                        |

```ts
@Injectable()
export class ProductService {
  @Cached({
    key: (id: string) => `product:${id}`,
    ttlMs: 600_000,
  })
  async getProduct(id: string) {
    return this.db.products.findById(id);
  }
}
```

The decorator injects the `CacheManager` automatically. Stampede protection (request coalescing) is included — concurrent calls for the same key share a single method invocation.

---

### `CACHE_MANAGER`

Injection token for the `CacheManager` instance. Use this for manual injection:

```ts
import { Inject } from "@nestjs/common";
import { CACHE_MANAGER } from "@ziggurat/nestjs";
import type { CacheManager } from "@ziggurat/core";

@Injectable()
export class MyService {
  constructor(@Inject(CACHE_MANAGER) private cache: CacheManager) {}

  async doSomething() {
    return this.cache.wrap("key", () => this.expensiveWork());
  }
}
```
