# Architecture Review — Ziggurat

**Date:** 2026-08-19
**Reviewer role:** Senior principal architect, full-implementation review
**Scope:** All six packages (`core`, `redis`, `memcache`, `sqlite`, `nestjs`, `otel`), docs, package manifests, CI, and repo tooling.
**Method:** Every source file read in full. Full build + test suite executed: **12/12 turbo tasks pass** (unit, contract, and integration suites). Claims below that depend on tooling behavior (e.g. Vitest 4) were verified against the installed dependencies, not assumed.
**Relation to prior review:** `CODE_REVIEW.md` (2026-06-11, v0.1.x) — nearly all of its findings are fixed in the current code. A status appendix is at the end. This document reviews the codebase as it stands at v0.2.0.

> **Resolution status:** H1–H3, M1–M6, and L1–L6 were fixed in the follow-up branch `fix/architecture-review-findings`; the findings below are preserved as written at review time. Still open: **L7** (publishing the adapter contract suite as a test kit) and **L8** (API/perf polish), plus the five architectural observations, which are roadmap items rather than defects.

---

## Executive Summary

Ziggurat is in very good shape for a v0.2 library. The core abstraction (an ordered stack of `CacheAdapter`s orchestrated by a `CacheManager`) is clean, the stampede coalescing is implemented correctly (in-flight promise registered synchronously before any yield), the event system is genuinely zero-cost when unobserved, and the testing story — a shared 82-case contract suite run against every adapter plus functional tests against real Redis/Memcached backends in CI — is stronger than most published caching libraries.

The most important problem found is not a crash bug but a **semantic contradiction between the code and its own documentation on backfill TTLs** — the library's central feature. Three docs promise "L1 always uses its own TTL policy" while the code gives backfilled entries the _source layer's remaining TTL_. One of the two is wrong, and the divergence was introduced by a deliberate fix (the TTL-precedence flip from the June review) whose ripple effects on backfill were never reconciled.

Everything else is medium-or-lower: an injection-token collision waiting to happen in the NestJS package, a broken leftover Vitest workspace file, some sharp edges around empty Redis prefixes and read-repair races, and a handful of doc drift.

---

## What's Working Well

- **Layered orchestration is properly separated from storage.** `CacheManager` owns cross-layer policy (read-through order, backfill, write fan-out, coalescing, events); adapters own storage semantics. `BaseCacheAdapter` gives adapter authors sane defaults for the extended surface (`has`, `getTtl`, `mget`, `mset`, `mdel`) so a minimal adapter is four methods.
- **Stampede coalescing is correct.** The in-flight promise is created and registered inside the same synchronous continuation as the cache-miss check (`cache-manager.ts:220-244`), so there is no interleaving window between miss detection and registration. Factory errors propagate to all coalesced callers and the map entry is cleaned up in `finally`.
- **Observability design is right.** Events are typed, gated by `hasListeners` so an unobserved manager pays ~nothing, listener exceptions can't break cache operations, and the OTel package is a thin translator over the event stream that depends only on `@opentelemetry/api`.
- **Failure philosophy is coherent and documented.** Reads skip failing layers; writes are `allSettled` best-effort with an opt-in `strictWrites` escape hatch; `wrap()` always returns the factory value even when caching it fails.
- **Testing and CI are a real strength.** Shared contract suite (`core/tests/contract/adapter-contract.test.ts`) reused by every adapter, hermetic-by-default with functional suites behind explicit opt-in, real backends in a CI matrix, CodeQL/OSV/Semgrep/gitleaks, pinned action SHAs, Codecov via OIDC.
- **Security posture in the code itself:** SQL identifier validation for the SQLite table name, glob-escaping of the Redis prefix in SCAN patterns, no dynamic SQL beyond parameterized `IN` lists.
- **The June review was acted on thoroughly** — 10 of 12 findings fully fixed, including subtle ones (Memcached >30-day TTLs, pipeline error surfacing, decorator metadata preservation).

---

## Findings

### High

#### H1. Backfill TTL semantics contradict the documentation (core feature)

**Code:** `packages/core/src/base-cache-adapter.ts:48`, `packages/core/src/cache-manager.ts:90-99` and `:302-317`
**Docs contradicted:** `docs/core-concepts.md:58` and `:189-193`, `docs/advanced-usage.md:30-31`, `README.md:100`

The manager computes the source entry's remaining TTL and passes it to the target layer as an **explicit** `ttlMs`. Since the June TTL-precedence flip, an explicit TTL beats `defaultTtlMs` (`ttlMs ?? this.defaultTtlMs`), so the target layer's own TTL policy is ignored during backfill — only `maxTtlMs` can cap it.

The docs say the opposite, in three places:

- `core-concepts.md:58`: _"If the target adapter has a `defaultTtlMs`, backfill uses that TTL. … This means L1 always uses its own TTL policy, regardless of L2's expiration."_
- `core-concepts.md:189-193` ("TTL Resolution Order"): _"Adapter's `defaultTtlMs` (if set) — always wins"_ — this section still documents the **pre-flip** precedence for all TTL resolution, contradicting both the code and `api-reference.md` (which is correct).
- `advanced-usage.md:30-31` (the recommended two-layer pattern): _"On a Redis hit, memory is auto-backfilled with memory's own 30s TTL."_

**Real-world consequence:** a user who follows the recommended pattern — `MemoryAdapter({ defaultTtlMs: 30_000 })` over `RedisAdapter({ defaultTtlMs: 300_000 })` — gets L1 entries that live up to **5 minutes**, not 30 seconds. The L1 staleness budget silently becomes L2's. The README example only behaves as advertised because it happens to use `maxTtlMs` instead of `defaultTtlMs`.

**Recommendation:** decide the semantics deliberately, then make code and docs agree. My recommendation is to make backfill honor the target layer's policy: pass the remaining TTL but clamp it, i.e. effective backfill TTL = `min(remainingTtlMs, target.defaultTtlMs ?? ∞, target.maxTtlMs ?? ∞)`. That matches the documented intent ("each layer manages its own TTL"), keeps the safety property that a backfilled entry never outlives the source entry, and keeps `maxTtlMs` meaningful. If instead the current behavior is the intent, all three doc passages plus the `core-concepts.md` TTL-resolution section need rewriting. Either way, add an integration test pinning the chosen behavior — nothing in the current suite catches this divergence, which is how the docs drifted.

#### H2. NestJS injection token `"CACHE_MANAGER"` collides with `@nestjs/cache-manager`

**Code:** `packages/nestjs/src/constants.ts:2`

The token value is the bare string `"CACHE_MANAGER"` — the same string token the official `@nestjs/cache-manager` package uses. `ZigguratModule` also registers itself `global: true` unconditionally. An application using both (a very common state mid-migration, or when a third-party module pulls in Nest's cache) ends up with two global providers competing for one string token; which instance gets injected depends on module resolution order, and the failure mode is a silently wrong object at runtime (`this.cache.wrap is not a function`, or worse, Nest's manager quietly serving where Ziggurat was expected).

**Recommendation:** change the token _value_ to something owned (`"ZIGGURAT_CACHE_MANAGER"`, or a `Symbol`); the exported constant name can stay `CACHE_MANAGER` so most consumers see no break. Do this before adoption grows — it's a breaking change for anyone who hardcoded the string, and it only gets more expensive.

#### H3. `vitest.workspace.ts` is dead and broken under Vitest 4

**Code:** `vitest.workspace.ts` (repo root)

The file calls `defineWorkspace` from `vitest/config`. Verified against the installed `vitest@4.1.10`: **that export no longer exists** (workspace files were deprecated in Vitest 3 and removed in 4). CI never notices because tests run per-package through turbo, so the file is simultaneously broken and unused — but any contributor who runs `vitest` from the repo root gets a confusing failure.

**Recommendation:** delete it, or migrate to the `projects` field in a root `vitest.config.ts` if root-level test invocation is wanted.

### Medium

#### M1. Redis adapter's empty default prefix makes `clear()` a database-wide delete

**Code:** `packages/redis/src/redis-adapter.ts:22`, `:108-119`

`prefix` defaults to `""`, so `clear()` (and `flushAll()`, which inherits `clear()` via the base class) scans `MATCH *` and pipeline-deletes **every key in the Redis database**, including keys belonging to other applications. The corrupt-payload read-repair path has the same blast-radius property (a foreign, non-JSON key read through the adapter gets deleted). The docs warn about this clearly (`redis-adapter.md`), but a documented footgun with a dangerous _default_ is still a footgun — the safe configuration should be the default, not the recommendation.

**Recommendation:** either require `prefix` (constructor throws on empty — breaking but honest), or make `clear()` throw on an empty prefix unless an explicit `allowUnprefixedClear: true` opt-in is set. (Memcached's global `flush()` is different: the protocol offers nothing better, and the docs say so loudly. That one is acceptable as-is.)

#### M2. `wrap()` miss path blocks on writing every layer

**Code:** `packages/core/src/cache-manager.ts:233`

After the factory resolves, `wrap()` awaits `setLayers()` — writes to _all_ layers — before resolving. Every coalesced waiter shares that promise, so all of them wait too. This is inconsistent with the library's own latency philosophy: backfill is fire-and-forget by default (`syncBackfill: false`) precisely so a slow layer doesn't tax reads, yet a slow-but-alive Redis adds its full write latency to every `wrap()` miss for every coalesced caller. A dead layer is fine (fast rejection, `allSettled`); a degraded one (100–500 ms writes) directly inflates p99 on the hottest path in the library.

**Recommendation:** return the factory value as soon as it's known and let the layer writes settle in the background (surfacing failures via `error` events, exactly like backfill), or gate the behavior on an option (`syncWrites`, defaulting to the current behavior for read-your-write safety). Whichever way, document the choice — today it's implicit.

#### M3. Read-repair deletes race with concurrent writers

**Code:** `packages/sqlite/src/sqlite-adapter.ts:114-117` and `:166-169`; `packages/redis/src/redis-adapter.ts:37-45`; `packages/memcache/src/memcache-adapter.ts:36-45`

All three shared-storage adapters do lazy expiry/corruption cleanup as _read, then unconditionally delete by key_. Between the read and the delete, another process can write a fresh entry — which the delete then destroys. SQLite is the most exposed (multi-process WAL usage is an advertised use case, and the fix is trivial: add `AND expires_at IS NOT NULL AND expires_at <= ?` to the cleanup delete). Redis/Memcached need atomicity (Lua script / CAS) to fix properly, which is likely not worth it — but the race should be documented.

Related: for Redis and Memcached the envelope's `expiresAt` is written with the **writer's** clock and enforced with each **reader's** clock. With clock skew between app instances, a skewed reader can treat valid shared entries as expired and _delete them for everyone_ — turning one machine's clock problem into a fleet-wide cache-miss problem. Redis already enforces TTL server-side via `PSETEX`; consider treating the envelope check as advisory (return a miss without issuing `DEL`) so a skewed reader only harms itself.

#### M4. `mget` partial-failure semantics differ per adapter

**Code:** `packages/core/src/base-cache-adapter.ts:81-90` vs `packages/redis/src/redis-adapter.ts:127-165`

`BaseCacheAdapter.mget` uses `Promise.all` over individual `get()`s — one failing key rejects the whole batch, and the manager then skips that **entire layer** (`cache-manager.ts:272-284`). `RedisAdapter.mget` does the opposite: per-key errors are skipped and a partial map is returned. So the same partial-failure scenario produces different results depending on the adapter, and `api-reference.md` documents only Redis's behavior. The adapter contract (`types.ts:40`) is silent on which is correct.

**Recommendation:** declare partial-result semantics as the contract (it composes better with the manager's shrinking-set loop), switch the base implementation to `allSettled`, and add a contract-suite case so all adapters are held to it.

#### M5. `set(key, undefined)` does four different things on four adapters

- Memory/reference: stored, but reads report a **miss** (node-cache can't distinguish "missing" from "stored undefined").
- Memory/json: write skipped entirely — documented (`types.ts:200-206`).
- Redis/Memcache: `JSON.stringify({value: undefined, …})` drops the key — future reads are **hits with `value: undefined`**.
- SQLite: `JSON.stringify(undefined)` is `undefined` → better-sqlite3 rejects the bind → **throws**.

**Recommendation:** pick one rule — "undefined is never stored; the write is a silent no-op" (the memory/json behavior) is the most defensible — apply it in `CacheManager.setLayers`/`wrap` once, centrally, and add a contract test. One central check is cheaper than four adapter fixes.

#### M6. Published Node support is never tested

Packages declare `"engines": { "node": ">=20" }` and the README promises Node ≥ 20, but CI runs everything on Node 22 only (`ci.yml`). The root repo requires Node ≥ 22.13 for development. Node 20 consumers are one `Array.fromAsync`-style API away from a runtime break no test would catch.

**Recommendation:** add a Node version matrix (20 / 22 / 24) to the `validate`+`test` jobs, or raise the published floor to 22 and update README/engines together.

### Low

- **L1. Doc drift (small, several spots):** `advanced-usage.md:459` and the `docker-compose.yml` header comment reference `.github/workflows/functional-tests.yml`, which doesn't exist (functional jobs live in `ci.yml`). `memcache-adapter.md` says "`CacheManager.keys()` will exclude keys from Memcache layers" — `CacheManager` has no `keys()`. `redis-adapter.md`'s "Monitor Key Count" tip claims `clear()` uses `KEYS`, contradicting both the code and the same document's earlier (correct) statement that it uses incremental `SCAN`.
- **L2. Dead public API:** `ZIGGURAT_OPTIONS` (`packages/nestjs/src/constants.ts:1`) is exported from the package index but used nowhere — nothing ever provides it. Remove it or wire it up; today it's API surface that promises something that doesn't exist.
- **L3. Codecov upload omits the otel package** — `ci.yml:57` lists coverage files for five packages; `packages/otel/coverage` is missing, so its coverage silently never reaches Codecov.
- **L4. OTel metrics carry no namespace attribute.** Every event includes `namespace`, but the instrumentation drops it — two instrumented managers (e.g. `users` and `products`) are indistinguishable in metrics. Add `cache.namespace` to the attribute sets.
- **L5. `mget` metrics are wrong with duplicate keys** (`cache-manager.ts:263`, `:346`): the ns-key map collapses duplicates, so `missCount = keys.length - result.size` over-counts. Metrics-only; dedupe up front if you care.
- **L6. SQLite adapter never sets `busy_timeout`.** With multiple processes writing through WAL, a concurrent writer gets an immediate `SQLITE_BUSY` throw instead of a brief wait. One `pragma busy_timeout = <ms>` in the constructor (next to the WAL pragma) removes a whole class of spurious layer errors.
- **L7. The contract suite isn't reusable outside the monorepo.** Adapter packages import it via relative path (`../../../core/tests/contract/…`). `custom-adapters.md` invites third parties to build adapters, but they can't run the compliance suite that keeps the first-party adapters honest. Publishing it (e.g. `@ziggurat-cache/adapter-testkit`) would be a differentiating move for an adapter-ecosystem library.
- **L8. Minor API/perf polish:** `del()` is a pure alias of `delete()` — one name is enough this early; `manager.has()` probes layers sequentially with full `get()`s (Redis could answer `EXISTS`/`PTTL` for `has`/`getTtl` at the cost of skipping envelope-expiry checks); listener exceptions are swallowed with no trace even in development (`event-emitter.ts:26-29`) — deliberate and defensible, but an opt-in debug hook would help people wondering why their metrics listener is silent.

---

## Architectural Observations (beyond findings)

These are not defects — they're the design decisions I'd want on the roadmap discussion for 1.0.

1. **There is no lifecycle contract.** `CacheAdapter` has no `dispose()`; `MemoryAdapter.close()` exists ad hoc; `CacheManager` has no shutdown; `ZigguratModule` registers no `onApplicationShutdown`. Long-running apps with `checkPeriodMs` timers or injected clients have no orderly teardown path through the library's own abstractions. An optional `dispose?(): Promise<void>` on the adapter contract, a `CacheManager.close()` that fans out to it, and a Nest lifecycle hook would complete the story.
2. **The NestJS integration is single-cache by construction.** One global module, one token, one manager. Real applications typically want several namespaced caches with different layer stacks (`users` in memory+redis, `reports` in sqlite). A `forFeature()` / named-registration API is the natural next step; the current design makes users hand-roll providers.
3. **Stampede protection is per-process only.** Coalescing collapses concurrent misses within one process; N pods still make N factory calls. That's the right v0 scope, but the README's "100 simultaneous requests = 1 database query" is only true on one instance — worth a doc caveat now, and worth roadmap slots for the standard escalation path: TTL jitter → probabilistic early refresh (stale-while-revalidate) → distributed lock via an adapter capability.
4. **The Redis/Memcache envelope duplicates expiry bookkeeping.** `expiresAt` inside the JSON exists so the manager can compute remaining TTL for backfill without an extra `PTTL` round-trip — a reasonable trade — but it's also what creates the clock-skew and read-repair issues in M3. If backfill TTL derivation changes for H1, revisit whether the envelope check should remain load-bearing or become advisory.
5. **`getTtl()` returns the first layer's answer**, which after H1 is resolved may legitimately differ from deeper layers. Fine — but say so in the API reference.

---

## Appendix: Status of the 2026-06-11 Review

| #   | Finding (June)                       | Status now                                                                                                                  |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | NestJS peer range excluded Nest 11   | **Fixed** (`^10.0.0 \|\| ^11.0.0`)                                                                                          |
| 2   | `flushAll()` used `FLUSHDB`          | **Fixed** (prefix-scoped SCAN) — empty-prefix blast radius remains → M1                                                     |
| 3   | Cross-layer value fidelity           | **Addressed** (`serialization: "json"` option + docs; reference default kept, documented)                                   |
| 4   | Backfill failures invisible          | **Fixed** (settled results feed `emitWriteErrors`) — note the `backfill` event still fires at schedule time, not completion |
| 5   | Unbounded growth (memory/sqlite)     | **Fixed** (`checkPeriodMs`, `maxKeys`, `purgeExpired()`)                                                                    |
| 6   | `defaultTtlMs` overrode explicit TTL | **Fixed in code** — but backfill semantics + `core-concepts.md` were never reconciled → **H1**                              |
| 7   | Memcached >30-day TTLs               | **Fixed** (absolute timestamp)                                                                                              |
| 8   | Redis fractional TTLs                | **Fixed** (`Math.ceil`)                                                                                                     |
| 9   | Prefix not glob-escaped              | **Fixed** (`escapeGlob`) — empty-prefix concern remains → M1                                                                |
| 10  | No `engines` in published packages   | **Fixed** — but untested on Node 20 → M6                                                                                    |
| 11  | `@Cached` dropped metadata           | **Fixed** (metadata + name preserved)                                                                                       |
| 12  | All-layer write failures silent      | **Fixed** (`strictWrites` + docs)                                                                                           |
| Low | `undefined` semantics divergence     | **Still open** → M5                                                                                                         |
| Low | Namespace `:` collisions             | **Documented** (`core-concepts.md:52`) — accepted                                                                           |
| Low | OTel missing m-ops                   | **Fixed**                                                                                                                   |

---

## Recommended Priorities

1. **Resolve H1 now** — decide backfill TTL semantics, align code + three doc passages, and pin the behavior with a test. It's the library's headline feature and currently the docs make a promise the code doesn't keep.
2. **Rename the `CACHE_MANAGER` token value (H2)** while the breaking change is still cheap.
3. **Delete/replace `vitest.workspace.ts` (H3)** and add the Node version matrix (M6) — both are small.
4. **Fold M1–M5 into the 1.0 contract work**: safe-by-default Redis `clear()`, `wrap()` write-latency policy, uniform `mget`/`undefined` semantics in the adapter contract + contract suite, and the SQLite delete guard.
5. **Sweep the doc drift (L1)** in one pass — this codebase's docs are good enough that the few stale spots stand out.
