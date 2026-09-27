# Ziggurat: Principal Architecture Review

**Date:** 2026-09-26  
**Version:** 0.3.0  
**Reviewed commit:** `38bfb0d4fcd4e7d47306a03d985faa53fc66c61a`  
**Scope:** All six packages, adapter contracts, tests, public documentation, package configuration, and CI.

> **Resolution status:** R1, R3, and the in-process part of R2 are fixed in [#74](https://github.com/camcima/ziggurat/pull/74). R2's remaining cases (writes already sent to a layer, backfills, cross-process ordering) are documented as out of scope in `docs/core-concepts.md`. R4–R8 are still open. The findings below are preserved as written at review time.

## Assessment

The package boundaries are sensible, the implementation is small enough to audit, and the shared adapter tests provide a useful foundation. The main remaining risks concern concurrency and failure semantics. Two confirmed defects deserve priority: a synchronous factory exception can permanently prevent retries for a key, and work started before a mutation can later restore stale data.

I would fix those issues before recommending the library for workloads that rely on invalidation for freshness. For data where bounded staleness is acceptable, the design is practical, provided applications configure finite TTLs and backend timeouts. The current API does not provide distributed coherence or atomic writes across layers.

This review found **eight actionable findings: two high, five medium, and one low**. The medium findings include an architectural resilience gap; they are not all implementation bugs. Existing review files are preserved, and resolved findings from them are not counted again.

## Findings at a glance

| ID  | Priority | Finding                                                              | Main consequence                                                     |
| --- | -------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| R1  | High     | Synchronous factory throws leave a rejected promise registered       | Subsequent misses cannot retry that key                              |
| R2  | High     | Invalidation and writes do not fence older asynchronous work         | Stale values can overwrite new values or reappear after deletion     |
| R3  | Medium   | Coalescing starts after each caller's independent cache read         | Overlapping calls can run the factory more than once                 |
| R4  | Medium   | Redis and Memcache trust parsed JSON without validating the envelope | Invalid hits, skipped factories, or loss of an entire Redis batch    |
| R5  | Medium   | Batch reads discard per-key failures without reporting them          | Backend outages can appear as ordinary misses with zero error events |
| R6  | Medium   | Failure isolation has no operation deadline                          | A stalled layer prevents fallback or completion                      |
| R7  | Medium   | Wrap miss duration excludes awaited cache writes                     | Metrics understate caller latency                                    |
| R8  | Low      | SQLite's zero busy timeout does not disable an existing timeout      | Configuration leaves unexpected synchronous waits in place           |

### R1. A synchronous factory exception prevents retries

**Evidence:** [cache-manager.ts](packages/core/src/cache-manager.ts#L242), lines 242–272.

The asynchronous IIFE calls `factory()` before its promise is placed in `inFlightFetches`. If the factory throws synchronously, the `finally` block runs immediately and deletes an entry that has not yet been inserted. The caller then inserts the already-rejected promise. Subsequent cache misses return that same rejection without invoking a new factory.

A callback that throws is valid for the declared `() => Promise<T>` signature: TypeScript can infer its return type as `never`. A normal function that validates arguments before returning a promise can also trigger this.

**Confirmed reproduction:**

```ts
const cache = new CacheManager({ layers: [new MemoryAdapter()] });
await cache
  .wrap("k", () => {
    throw new Error("first failure");
  })
  .catch(() => {});
await cache.wrap("k", async () => "recovered");
// Rejects with "first failure"; the second factory is never called.
```

**Recommendation:** Register the operation before invoking user code. Defer execution to a promise continuation and clean up only if the map still contains that operation's promise. Avoid creating an unobserved rejecting promise during cleanup.

**Regression test:** A synchronous throw followed by a successful factory must recover. Retain separate coverage for asynchronously rejected factories and concurrent callers.

### R2. Older work can undo a completed mutation

**Evidence:** [cache-manager.ts](packages/core/src/cache-manager.ts#L111), lines 111–135, 178–201, 242–266, and 334–368.

Factories and backfills write unconditionally. `set`, `mset`, `delete`, and `mdel` neither mark older reads as obsolete nor coordinate their later writes.

Two deterministic interleavings were reproduced:

1. Start `wrap("k")` and pause its factory. Complete `delete("k")`. Resolve the factory with the old value. The deleted key reappears.
2. L1 misses; L2 captures the old value and delays its response. Complete `set("k", "new")` on both layers. Release the old L2 response. Backfill overwrites L1 with `"old"`, while L2 still holds `"new"`.

Both happen in one manager with healthy adapters. The second was reproduced with `syncBackfill: true`, so waiting for backfill does not establish ordering against concurrent mutations. Without a finite TTL, the restored value can remain indefinitely.

**Recommendation:** Define the local ordering guarantee explicitly. Track per-key mutation generations so factories and reads can detect that their results became obsolete. Also coordinate writes that have already been scheduled: generation checks alone do not stop a delayed backend write from completing after a newer mutation. Per-key mutation ordering or conditional backend writes are possible approaches. Cover the batch paths too.

Across processes, local bookkeeping is insufficient. If stronger freshness is required, use shared versions, conditional writes, or an invalidation mechanism. Document the scope of any guarantee.

**Regression tests:** Gate promises to exercise delete during factory execution, set during an L2 read, and a delayed backfill write completing after delete. Repeat for batch operations. Verify that an invalidated in-flight factory is not reused by a later caller.

### R3. Concurrent wraps can escape coalescing during cache lookup

**Evidence:** [cache-manager.ts](packages/core/src/cache-manager.ts#L220), lines 220–239 and 264–272; [stampede documentation](docs/core-concepts.md#L137).

Every caller awaits its own `get()` before checking `inFlightFetches`. A second lookup can capture a miss, then return only after the first caller has computed, cached, and removed its in-flight promise. The second caller uses that obsolete miss and starts another factory.

**Confirmed reproduction:** Two overlapping wraps used a memory adapter whose second read captured a miss and waited. After the first wrap completed, releasing the second read caused a second factory execution. This occurred with the default awaited write policy.

The existing tests mostly keep the factory slow relative to the reads, which does not expose this ordering. The documentation's assertion that all concurrent callers receive one factory result is therefore too broad.

**Recommendation:** Coalesce the entire read/compute/write operation for a key, registering it before the initial asynchronous lookup. Preserve the explicitly configured behavior when coalescing is disabled. Document that deduplication is scoped to a manager instance; independent managers and processes have separate maps.

**Regression test:** Delay one cache-miss response beyond another caller's successful write and assert a single factory invocation.

### R4. Parsed JSON is accepted without validating the cache envelope

**Evidence:** [Redis adapter](packages/redis/src/redis-adapter.ts#L42), lines 42–60 and 175–185; [Memcache adapter](packages/memcache/src/memcache-adapter.ts#L33), lines 33–51.

`JSON.parse` validates JSON syntax, but its result is cast directly to `CacheEntry<T>`:

- `{}` passes the expiry check and becomes a hit. `wrap()` returns `undefined` and never calls its factory.
- JSON `null` causes `entry.expiresAt` to throw. In Redis `mget`, this happens outside the parsing `try` block, so one such payload rejects the entire batch, including valid entries.
- An envelope without `value` can be produced by the adapters themselves: a function, symbol, or object whose `toJSON()` returns `undefined` disappears during envelope serialization. Checking only `value === undefined` does not cover those inputs.

**Confirmed reproduction:** A stub Redis client returned `{}` and `null`. The first suppressed the factory; the second rejected a batch containing a valid hit. Writing an object whose `toJSON()` returned `undefined` generated an envelope containing only `expiresAt`.

**Recommendation:** Centralize envelope decoding. Require a non-null object with an own `value` property and `expiresAt` equal to `null` or a finite number. Treat malformed envelopes as misses per key. Separately define which values can be serialized and apply that policy consistently across JSON adapters. Consider an envelope version if format evolution is expected.

**Regression tests:** Cover `null`, arrays, scalars, missing fields, invalid expiry types, unsupported values, and mixed valid/invalid batches. Envelope validation cannot establish the application's generic `T`; runtime value schemas would be a separate optional feature.

### R5. Batch outages disappear from error reporting

**Evidence:** [base-cache-adapter.ts](packages/core/src/base-cache-adapter.ts#L92), lines 92–100; [Redis adapter](packages/redis/src/redis-adapter.ts#L171), lines 171–173; [manager batch handling](packages/core/src/cache-manager.ts#L302), lines 302–317.

The base `mget` collects `Promise.allSettled` results but discards every rejection. Redis skips individual command errors. The manager sees a fulfilled partial or empty map and emits no error event for those failures.

**Confirmed reproduction:** A memory-derived adapter whose `get()` always throws returned an empty batch through the base implementation. An attached manager error listener received zero events. Memcache uses the same base batch implementation.

Partial results are useful, but returning them should not erase the distinction between a missing key and a failed read. Error counters can otherwise remain at zero while the application sends every request to its origin.

**Recommendation:** Preserve partial results and expose per-key failures through a structured batch result or an adapter-to-manager reporting hook. At minimum, propagate a total read failure while retaining partial-result behavior for successful keys; document that this minimal approach still omits partial-failure telemetry.

**Regression tests:** Cover mixed success/failure and complete failure, asserting both returned values and emitted errors. Run these cases across adapters rather than only the base implementation.

### R6. A stalled layer defeats failure isolation

**Evidence:** [cache-manager.ts](packages/core/src/cache-manager.ts#L83), lines 83–98, 162–164, 189–191, and 255–259; [manager options](packages/core/src/types.ts#L172).

The manager handles rejected promises, but provides no deadline for promises that remain pending. Reads await layers sequentially. Writes await every layer, and `wrapWrites: "await"` is the default. A stalled read prevents fallback; a stalled write holds the wrap result and all coalesced callers even after the factory succeeds.

**Confirmed reproduction:** A first-layer `get()` that never settles prevented access to a healthy populated second layer. An external 30 ms observation window expired without a result. The source has no subsequent timeout path.

This is a resilience contract gap. Applications may already impose suitable timeouts through their clients, but the manager does not require or enforce them.

**Recommendation:** Define where deadlines are owned. Support configurable per-layer operation deadlines, or require and demonstrate bounded client settings. Emit timeout errors and permit read fallback. If adding cancellation, distinguish abandoning the wait from cancelling the backend action: a timed-out write can still complete later and must be considered alongside R2. Synchronous SQLite work cannot be interrupted by a JavaScript promise timeout; its contention and batch limits need separate treatment.

**Regression tests:** Exercise never-settling reads and writes, fallback, timeout events, cleanup, and late completion. Circuit breaking can follow once deadline behavior is stable.

### R7. Wrap latency metrics omit awaited writes

**Evidence:** [cache-manager.ts](packages/core/src/cache-manager.ts#L245), lines 245–259; [OpenTelemetry instrumentation](packages/otel/src/instrumentation.ts#L155), lines 155–165.

`wrap:miss` fires immediately after the factory, before cache writes start. Its `durationMs` is recorded as operation duration by the OTel package. With the default awaited writes, it omits part of the latency experienced by every caller.

**Confirmed reproduction:** A layer with a 60 ms write delay produced a wrap miss event of approximately **0.23 ms**, while the awaited call took approximately **61.39 ms**.

**Recommendation:** Record the completed wrap duration after applying the selected write policy. Keep factory duration separate. If a factory-completed event is useful, give it a distinct meaning rather than using it as end-to-end duration. Review hit duration with `syncBackfill` as well: the current hit event precedes the awaited backfill.

**Regression test:** Hold a write behind a gate and verify that the completion event follows the write for `"await"`, and precedes it for `"background"`.

### R8. `busyTimeoutMs: 0` preserves an existing SQLite timeout

**Evidence:** [SQLite adapter](packages/sqlite/src/sqlite-adapter.ts#L27), lines 27–32 and 74–77.

The option documentation describes zero as no wait, but the implementation only sets the pragma when the value is positive. Zero therefore leaves the supplied database connection's timeout unchanged.

**Confirmed reproduction:** Create a database with `{ timeout: 1234 }`, then construct the adapter with `busyTimeoutMs: 0`. `PRAGMA busy_timeout` still returns `1234`.

**Recommendation:** Validate the option and apply zero explicitly if it means no wait. Alternatively, define a separate “preserve client configuration” policy and document it accurately. This matters because a busy wait occurs inside synchronous database calls.

**Regression test:** Supply a database with a nonzero timeout, configure zero, and assert the resulting pragma.

## Architectural strengths to retain

- **Clear package boundaries.** Core orchestration is independent of Redis, Memcache, SQLite, NestJS, and OTel. Backend clients are supplied by callers, and adapter imports of their types do not force runtime client construction.
- **Central TTL policy.** `BaseCacheAdapter` validates TTL inputs, resolves defaults and caps, and exposes an immutable policy. Backfill now applies the target's default while respecting the source's remaining lifetime.
- **Useful extension point.** `CacheAdapter` plus `BaseCacheAdapter` makes a custom backend straightforward; shared contracts reduce routine semantic drift.
- **Explicit operational choices.** `strictWrites`, `wrapWrites`, memory serialization, and backfill policy make several tradeoffs visible to users.
- **Backend safeguards.** Redis guards unprefixed clearing and escapes prefixes. SQLite validates table names, chunks large key lists, and uses transactions for batch mutations.
- **Substantial verification.** CI covers builds, static checks, coverage, backend functional tests, and loading ESM/CJS bundles on additional Node versions.

## Design decisions to settle before 1.0

These are documented tradeoffs or roadmap decisions, rather than additional confirmed defects.

### Define freshness across managers and processes

A local L1 is not invalidated when another manager or process changes shared L2. A finite `maxTtlMs` can bound that stale period; permanent L1 entries cannot. State this explicitly in deployment guidance. If consumers need stronger coherence, decide whether the library will provide invalidation subscriptions or leave versioned keys and application events to consumers.

Also clarify that `strictWrites` requires only one successful layer. It does not guarantee that the next read sees the newly written value if an earlier layer retained an older value. The unconditional read-after-wrap guarantee in [types.ts](packages/core/src/types.ts#L182) should be qualified for failed writes, expiration, and concurrent mutations.

### Make destructive capabilities consistent

`clear()` is prefix-scoped in Redis, namespace-scoped in SQLite, and global across the Memcache client's servers. SQLite `flushAll()` spans namespaces, while Redis's is prefix-scoped. Memcache's global scope is documented, so this is not an undisclosed new finding, but interchangeable adapters still expose materially different destructive behavior.

Consider capability interfaces and an explicit opt-in for global Memcache clearing. Keep application namespaces distinct from backend administration boundaries.

### Specify resource ownership and shutdown

Memory has `close()`, but the common adapter contract and manager have no shutdown/drain API, and the Nest module adds no shutdown coordination. Background writes can remain outstanding when an application closes its clients.

A lifecycle design should stop owned timers, drain tracked work within a bound, and leave externally owned clients open unless ownership was explicitly transferred. It should also say what happens to pending factories.

### Treat capacity as an operational policy

Memory's `maxKeys` rejects new keys; it is not an eviction policy. With the default disabled sweep, expired entries that are never accessed can keep consuming the entire capacity. A probe with `maxKeys: 1` confirmed that an expired old key prevented admission of a new key and remained visible in `keys()`.

The lazy-expiry default is documented. Improve production examples by combining capacity limits with cleanup, or adopt an eviction implementation that reclaims expired entries during admission. Consider byte limits for large values and bounded batch concurrency. Redis `clear()` also gathers every matching key before building one pipeline; process scan pages incrementally if large keyspaces are a target workload.

### Keep the public contract smaller than backend differences

Consider optional capabilities for enumeration, bulk clearing, lifecycle, and richer batch results. Memcache already inherits a `keys()` implementation that throws. Publish a reusable adapter test kit if third-party adapters are a product priority. Add named Nest registrations when multiple independently configured caches are needed; the current integration uses one global token.

## Validation and limitations

Tests ran on **Node v22.22.2 / pnpm 11.10.0**, using installed dependencies.

| Check                         | Result                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm build`                  | Passed for all six packages                                                                   |
| `pnpm test`                   | Passed: 637 reported test cases across 16 files                                               |
| `pnpm typecheck`              | Passed                                                                                        |
| `pnpm lint`                   | Passed                                                                                        |
| `pnpm test:functional:sqlite` | Passed: 96 reported test cases                                                                |
| `pnpm test:functional:redis`  | Passed: 111 reported test cases against a temporary Redis instance on an isolated Unix socket |
| Targeted review probes        | Ten behavior probes plus a separate latency probe confirmed the observations described above  |

Reported test counts include repeated shared-contract cases; they are not counts of unique behaviors. Redis was stopped and its temporary directory removed after testing. The probes used built packages, controlled promises, stub clients, and real in-memory SQLite; they did not modify library source or committed tests.

Memcache functional tests were not run because a dedicated local Memcached executable was unavailable. Its source, unit tests, and contract tests were reviewed, and its unit/contract suite passed. This review did not measure throughput, tail latency under load, fleet-wide coherence, or current dependency vulnerabilities. It is an architectural and correctness review, not a security certification.

## Recommended sequence

1. **Repair the per-key operation lifecycle:** R1–R3, with deterministic interleaving tests. Agree on mutation ordering before adding more background behavior.
2. **Harden the adapter boundary:** R4–R5, covering malformed envelopes and observable partial failures in shared contract tests.
3. **Define bounded failure behavior:** R6, including client settings, late writes, and shutdown ownership.
4. **Correct telemetry and configuration:** R7–R8, then qualify documentation guarantees.
5. **Validate production limits:** benchmark realistic value sizes, batch sizes, failure rates, and contention before adding distributed locking or more cache policies.

The library's structure supports these changes without a wholesale rewrite. The highest-value investment is a precise concurrency and failure contract backed by adversarial tests.
