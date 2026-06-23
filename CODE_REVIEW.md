# Code Review — Ziggurat

**Date:** 2026-06-11
**Scope:** Full source review of all six packages (`core`, `redis`, `memcache`, `sqlite`, `nestjs`, `otel`), docs, package configs, and CI. Full unit test suite executed: all 12 task groups pass.

## Overall Assessment

A well-built library for a v0.1.x. Highlights:

- Shared adapter contract test suite run against every adapter.
- `hasListeners`-gated event system avoids overhead when unobserved.
- Stampede coalescing registers the in-flight promise synchronously before yielding — the implementation is correct.
- SQL-injection-safe table name validation in the SQLite adapter.
- Genuinely thorough CI: CodeQL, OSV-Scanner, Semgrep, Codecov, and functional tests against real backends.

Findings below are ordered by severity.

---

## High

### 1. NestJS peer range excludes the version you test against

`packages/nestjs/package.json:51-53` declares `"@nestjs/common": "^10.0.0"` as a peer, but the devDependencies (and therefore all tests) use `^11.1.24`. Anyone installing into a Nest 11 app gets a peer conflict for a package that demonstrably works on 11.

**Fix:** `"^10.0.0 || ^11.0.0"`.

### 2. `RedisAdapter.flushAll()` wipes the entire Redis database

`packages/redis/src/redis-adapter.ts:172-174` calls `flushdb()`, destroying every key in that DB — including keys outside the adapter's `prefix` and any other application sharing the database. This is inconsistent with `clear()`, which is carefully prefix-scoped via SCAN.

Same family of footgun: `MemcacheAdapter.clear()` flushes the whole memcached server even when a `prefix` is configured (the code comment acknowledges it, but a user calling `clear()` on one cache will not expect a global flush).

**Fix:** Make `flushAll` prefix-scoped on Redis; at minimum put loud warnings in the API docs for the memcache case.

### 3. Cross-layer value fidelity is inconsistent

`MemoryAdapter` stores live references (`useClones: false`), while Redis/SQLite/Memcache JSON round-trip. Cache a `Date`, `Map`, or class instance and you get the real object back on an L1 hit but a plain JSON shape when L2 serves the same key after L1 eviction. The same data returns different types depending on which layer answers.

`useClones: false` also means callers can mutate a returned object and silently poison the cache for every subsequent reader.

**Fix:** Normalize (optional serialize/clone in `MemoryAdapter`) or add a prominent doc warning.

### 4. Backfill failures are completely invisible

`packages/core/src/cache-manager.ts:91-95` and `:290-292` collect backfill results with `Promise.allSettled` but never inspect them. Even with `syncBackfill: true` and an `error` listener attached, a failing backfill emits nothing, and the `backfill` event fires before the writes settle, so it reports success unconditionally.

**Fix:** Run the settled results through `emitWriteErrors` (adding `"backfill"` to the `CacheErrorEvent` operation union).

### 5. Unbounded growth in MemoryAdapter and SQLite

`packages/core/src/memory-adapter.ts:15` sets `checkperiod: 0`, disabling node-cache's periodic eviction, so expired entries are only removed when re-read; a write-heavy, read-rarely workload grows without bound. No `maxKeys` is exposed either.

SQLite has the same shape of problem: expired rows are deleted only on access, and the partial index on `expires_at` (`packages/sqlite/src/sqlite-adapter.ts:62-66`) is never used by any query — it looks like a `purgeExpired()` method was planned but never landed.

**Fix:** Add a `purgeExpired()` to the SQLite adapter; expose `checkperiod`/`maxKeys` on the memory adapter.

---

## Medium

### 6. `defaultTtlMs` overrides explicit per-call TTL

All four adapters do `this.defaultTtlMs ?? ttlMs`. The docs confirm this is intentional ("takes precedence over TTL passed via set/wrap"), but the name says the opposite — "default" universally means fallback. Consequences:

- `cache.set(key, v, 5_000)` silently ignores the 5s TTL.
- `@Cached({ ttlMs })` silently no-ops against such adapters.
- The manager's remaining-TTL computation for backfill is dead code whenever a default is set — including the edge where an entry that expired mid-read gets backfilled into L1 for the full default TTL (the `effectiveTtl <= 0` guard never sees the manager's `0`).

**Fix:** If override semantics are intended, rename (`fixedTtlMs` / `ttlOverrideMs`); otherwise flip to `ttlMs ?? this.defaultTtlMs`.

### 7. Memcached TTLs over 30 days expire immediately

Memcached interprets `expires` values greater than 2,592,000 seconds as an absolute unix timestamp, so `packages/memcache/src/memcache-adapter.ts:52-54` makes any TTL > 30 days expire instantly (a timestamp in the past).

**Fix:** Clamp to 30 days or convert to an absolute timestamp.

### 8. Redis rejects fractional TTLs

`PSETEX` requires an integer; a user-supplied float `ttlMs` (e.g. `1500.5`) makes `packages/redis/src/redis-adapter.ts:52` throw at runtime.

**Fix:** `Math.ceil(effectiveTtl)`.

### 9. Redis prefix is not glob-escaped

`clear()`/`keys()` build `MATCH` patterns as `prefix + "*"`; a prefix containing `*`, `?`, or `[` silently matches the wrong keys. Also, with no prefix configured, `clear()` scan-deletes the entire database — same blast-radius concern as finding 2.

**Fix:** Escape glob metacharacters in the prefix; consider requiring a non-empty prefix for `clear()`.

### 10. Published packages carry no `engines` field

Only the private root declares `node >=20`, so npm consumers get no signal. Relatedly, the README badge still advertises Node 18|20|22, contradicting the engines constraint, and the TypeScript badge says 5.5+ while development is on 6.x.

**Fix:** Add `engines` to every published package; update README badges.

### 11. `@Cached` drops method metadata

`packages/nestjs/src/cached.decorator.ts:24` replaces `descriptor.value` without copying Reflect metadata from the original function. Service methods are fine, but combined with NestJS decorators that stamp metadata onto the method function (route decorators, `@SetMetadata`), behavior depends on decorator order and metadata can vanish.

**Fix:** Copy `Reflect.getMetadataKeys(originalMethod)` onto the wrapper.

### 12. Writes that fail on every layer still report success

`set`/`mset`/`delete` never throw, and the error events only fire if a listener happens to be registered. "Resilient" is the right default for reads, but a fully-failed write with no observable signal can mask a total cache outage.

**Fix:** Consider a strict/throw-if-all-layers-fail option, or at least document that error listeners are the only way to see write failures.

---

## Low / Polish

- `cache-manager.ts:26-29`: `{ coalesce: true, ...options.stampede }` — an explicit `{ coalesce: undefined }` defeats the `Required<>` type. Use `options.stampede?.coalesce ?? true`.
- The `CacheManager` constructor stores `options.layers` by reference (the caller can mutate it afterward, despite `getLayers()` copying on the way out) and accepts an empty array, which makes every operation a silent no-op. Copy and validate.
- Namespace delimiter collisions: namespace `"a"` + key `"b:c"` produces the same key as namespace `"a:b"` + key `"c"`. Worth a doc note.
- Redis `mget` (`redis-adapter.ts:130`): one corrupt/legacy JSON payload throws and kills the entire batch — wrap the per-entry parse. Both Redis and Memcache `get()` also trust the parsed shape; a payload without `expiresAt` slips through the expiry check.
- SQLite: the constructor's WAL/synchronous pragmas persistently mutate the caller's database — document it. `mget`/`mdel` with very large key arrays exceed SQLite's bind-variable limit — chunk them. `set(key, undefined)` throws (`JSON.stringify(undefined)` is `undefined`), and undefined-value semantics differ across all four adapters.
- The OTel package doesn't instrument the `mget`/`mset`/`mdel` events — the counters exist in core but never reach metrics.
- `CacheManager` exposes no `clear()`/`keys()` passthrough; users must reach into `getLayers()`. May be intentional, but it's asymmetric with everything else being orchestrated.

---

## Top Three Before Next Release

1. **NestJS peer range** (finding 1) — blocks installation on Nest 11.
2. **`flushdb` blast radius** (finding 2) — destructive surprise for shared Redis databases.
3. **Backfill error swallowing** (finding 4) — silent failures in the library's core feature.
