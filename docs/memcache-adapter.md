# Memcache Adapter

The `@ziggurat-cache/memcache` package provides a `MemcacheAdapter` that uses [memjs](https://github.com/memcachier/memjs) to store cached values in Memcached. It's designed as a shared cache layer in a multi-layer cache stack.

## Installation

```bash
npm install @ziggurat-cache/memcache memjs
```

`memjs` is a peer dependency — you bring your own client and manage the connection lifecycle.

## Basic Setup

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";
import { MemcacheAdapter } from "@ziggurat-cache/memcache";
import memjs from "memjs";

const client = memjs.Client.create("localhost:11211");

const cache = new CacheManager({
  layers: [
    new MemoryAdapter({ defaultTtlMs: 30_000 }),
    new MemcacheAdapter({ client, defaultTtlMs: 600_000 }),
  ],
});
```

## Configuration

| Property       | Type           | Default      | Description                                                                                                                                    |
| -------------- | -------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `client`       | `memjs.Client` | _(required)_ | A configured memjs client instance.                                                                                                            |
| `prefix`       | `string`       | `""`         | Key prefix for infrastructure-level isolation.                                                                                                 |
| `defaultTtlMs` | `number`       | _none_       | Fallback TTL applied when no `ttlMs` is passed to `set`/`wrap`. An explicit `ttlMs` always wins. Use `maxTtlMs` to cap all TTLs for the layer. |
| `maxTtlMs`     | `number`       | _none_       | Upper bound applied to every entry's TTL — explicit TTLs, `defaultTtlMs`, and otherwise-permanent entries are all capped to this.              |

> **Warning:** memcached has no way to enumerate or delete keys by prefix, so `clear()` and `flushAll()` both call `flush` — wiping **the entire memcached server**, including keys written by other applications and other `MemcacheAdapter` prefixes. Avoid calling them in shared environments.

## TTL Handling

Memcached uses TTLs in **seconds**. The adapter automatically converts from milliseconds, rounding up with `Math.ceil`. A TTL of 0 (or omitted) means no expiration until evicted by memory pressure.

Maximum Memcached TTL is 30 days (2,592,000 seconds). Values larger than this are treated as Unix timestamps by the Memcached server.

TTLs longer than 30 days are automatically sent to memcached as an absolute expiry timestamp (memcached interprets large relative values as timestamps), so long TTLs behave correctly.

## Serialization

Values are JSON-serialized as `{ value, expiresAt }` strings and stored as Buffers. On retrieval, the Buffer is converted back to a string and parsed.

## Limitations

### No Key Enumeration

The Memcached protocol does **not support key enumeration**. Calling `keys()` on this adapter will throw an error:

```
Error: memcache does not support key enumeration. Override keys() to enable.
```

This means `CacheManager.keys()` will exclude keys from Memcache layers. If you need key enumeration, consider using Redis or SQLite as your backing store.

### No Namespace-Scoped Clear

Memcached has no concept of namespaces at the protocol level. Both `clear()` and `flushAll()` call `client.flush()`, which erases **all data** in the Memcached instance.

## Batch Operations

Memcached does not have native multi-key operations. The adapter uses the `BaseCacheAdapter` defaults, which execute individual `get`/`set`/`delete` calls in parallel via `Promise.allSettled`.
