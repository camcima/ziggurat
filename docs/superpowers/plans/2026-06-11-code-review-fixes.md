# Code Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all High and Medium findings (plus selected Low findings) from `CODE_REVIEW.md` dated 2026-06-11.

**Architecture:** Ziggurat is a pnpm/turbo monorepo. `@ziggurat-cache/core` provides `CacheManager` (multi-layer orchestration) and `BaseCacheAdapter` (shared adapter behavior); `redis`/`memcache`/`sqlite` packages implement adapters; `nestjs` and `otel` are integrations. The plan centralizes TTL resolution in `BaseCacheAdapter` (one breaking semantic change: explicit TTL now wins over `defaultTtlMs`, with a new `maxTtlMs` cap to preserve the per-layer-TTL feature), surfaces previously-swallowed backfill/write errors via the existing event system, and de-fangs the destructive Redis `flushAll`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, pnpm workspaces, turbo, tsup. Tests use hand-rolled mock clients (no real Redis/memcached needed for unit/contract tests).

**Conventions for every task:**

- Run commands from the repo root.
- All test files use vitest (`describe`/`it`/`expect`/`vi`).
- Commit messages follow conventional commits (commitlint is enforced via lefthook).
- After each task's final step, the full suite must be green: `pnpm build && pnpm test`.

**Explicitly out of scope (deferred, documented in Task 18):** unifying `undefined`-value semantics across adapters; `CacheManager.clear()`/`keys()` passthrough (YAGNI for now); making `MemcacheAdapter.clear()` non-global (memcached has no prefix-scoped flush; documented instead).

---

### Task 1: Fix NestJS peer dependency range (Finding 1, High)

**Files:**

- Modify: `packages/nestjs/package.json:50-54`

- [ ] **Step 1: Widen the peer ranges**

In `packages/nestjs/package.json`, replace:

```json
  "peerDependencies": {
    "@nestjs/common": "^10.0.0",
    "@nestjs/core": "^10.0.0",
    "reflect-metadata": "^0.2.0"
  },
```

with:

```json
  "peerDependencies": {
    "@nestjs/common": "^10.0.0 || ^11.0.0",
    "@nestjs/core": "^10.0.0 || ^11.0.0",
    "reflect-metadata": "^0.1.13 || ^0.2.0"
  },
```

- [ ] **Step 2: Verify install and tests**

Run: `pnpm install && pnpm --filter @ziggurat-cache/nestjs test`
Expected: install succeeds with no peer warnings for @nestjs/\*; 11 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/nestjs/package.json pnpm-lock.yaml
git commit -m "fix(nestjs): allow NestJS 11 in peer dependency range"
```

---

### Task 2: Add `engines` to published packages and fix README badges (Finding 10, Medium)

**Files:**

- Modify: `packages/core/package.json`, `packages/redis/package.json`, `packages/memcache/package.json`, `packages/sqlite/package.json`, `packages/nestjs/package.json`, `packages/otel/package.json`
- Modify: `README.md:13-14`

- [ ] **Step 1: Add engines to all six package.json files**

In each of the six `packages/*/package.json` files, add this top-level field directly after the `"type": "module",` line:

```json
  "engines": {
    "node": ">=20"
  },
```

- [ ] **Step 2: Fix the README badges**

In `README.md`, replace:

```markdown
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5%2B-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%20%7C%2020%20%7C%2022-green.svg)](https://nodejs.org/)
```

with:

```markdown
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5%2B-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-green.svg)](https://nodejs.org/)
```

- [ ] **Step 3: Verify formatting and commit**

Run: `pnpm format:check || pnpm format`
Then:

```bash
git add packages/*/package.json README.md
git commit -m "fix: declare node >=20 engines in published packages, correct README badge"
```

---

### Task 3: Centralize TTL resolution — explicit TTL wins, new `maxTtlMs` cap (Finding 6, Medium — BREAKING)

**Decision:** `defaultTtlMs` becomes a true fallback (`ttlMs ?? defaultTtlMs`). A new `maxTtlMs` option caps every TTL (including explicit TTLs, backfill TTLs, and permanent entries). This fixes the "explicit TTL silently ignored" surprise while preserving the marketed "L1 expires fast" multi-layer feature via `maxTtlMs`. Both knobs live in `BaseCacheAdapter` so all adapters share one implementation.

**Files:**

- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/base-cache-adapter.ts`
- Modify: `packages/core/src/memory-adapter.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/redis/src/redis-adapter.ts`
- Modify: `packages/sqlite/src/sqlite-adapter.ts`
- Modify: `packages/memcache/src/memcache-adapter.ts`
- Modify: `packages/core/tests/unit/base-cache-adapter.test.ts`
- Modify: `packages/core/tests/unit/memory-adapter.test.ts:150-157`
- Modify: `packages/redis/tests/unit/redis-adapter.test.ts:179-193`
- Modify: `packages/sqlite/tests/unit/sqlite-adapter.test.ts:314-320`
- Modify: `packages/memcache/tests/unit/memcache-adapter.test.ts:176-184`
- Modify: `packages/core/tests/integration/multi-layer.test.ts:140-163`

- [ ] **Step 1: Write failing tests for `resolveTtl` semantics**

Append to `packages/core/tests/unit/base-cache-adapter.test.ts` (a `TestAdapter extends BaseCacheAdapter` already exists in this file — reuse it, but it must now expose the new constructor; see Step 3. For the new tests, define a minimal subclass locally):

```ts
describe("TTL resolution (defaultTtlMs / maxTtlMs)", () => {
  class TtlProbeAdapter extends BaseCacheAdapter {
    readonly name = "ttl-probe";
    lastTtl: number | undefined;
    // eslint-disable-next-line @typescript-eslint/require-await
    async get<T>(): Promise<CacheEntry<T> | null> {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/require-await
    async set<T>(_key: string, _value: T, ttlMs?: number): Promise<void> {
      this.lastTtl = this.resolveTtl(ttlMs);
    }
    // eslint-disable-next-line @typescript-eslint/require-await
    async delete(): Promise<void> {}
    // eslint-disable-next-line @typescript-eslint/require-await
    async clear(): Promise<void> {}
  }

  it("uses explicit ttlMs when both ttlMs and defaultTtlMs are set", async () => {
    const a = new TtlProbeAdapter({ defaultTtlMs: 60_000 });
    await a.set("k", "v", 5_000);
    expect(a.lastTtl).toBe(5_000);
  });

  it("falls back to defaultTtlMs when ttlMs is omitted", async () => {
    const a = new TtlProbeAdapter({ defaultTtlMs: 60_000 });
    await a.set("k", "v");
    expect(a.lastTtl).toBe(60_000);
  });

  it("returns undefined (permanent) when neither is set", async () => {
    const a = new TtlProbeAdapter();
    await a.set("k", "v");
    expect(a.lastTtl).toBeUndefined();
  });

  it("caps explicit ttlMs at maxTtlMs", async () => {
    const a = new TtlProbeAdapter({ maxTtlMs: 30_000 });
    await a.set("k", "v", 600_000);
    expect(a.lastTtl).toBe(30_000);
  });

  it("does not raise short ttlMs to maxTtlMs", async () => {
    const a = new TtlProbeAdapter({ maxTtlMs: 30_000 });
    await a.set("k", "v", 1_000);
    expect(a.lastTtl).toBe(1_000);
  });

  it("bounds permanent entries at maxTtlMs", async () => {
    const a = new TtlProbeAdapter({ maxTtlMs: 30_000 });
    await a.set("k", "v");
    expect(a.lastTtl).toBe(30_000);
  });

  it("caps defaultTtlMs at maxTtlMs", async () => {
    const a = new TtlProbeAdapter({ defaultTtlMs: 60_000, maxTtlMs: 30_000 });
    await a.set("k", "v");
    expect(a.lastTtl).toBe(30_000);
  });
});
```

Add `CacheEntry` to the type imports at the top of the test file if not already imported.

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm --filter @ziggurat-cache/core test -- base-cache-adapter`
Expected: FAIL — `TtlProbeAdapter` constructor takes no arguments and `resolveTtl` does not exist.

- [ ] **Step 3: Implement `AdapterTtlOptions` and `resolveTtl` in core**

In `packages/core/src/types.ts`, add after the `TtlResult` type:

```ts
export interface AdapterTtlOptions {
  /**
   * Fallback TTL in milliseconds, applied when set()/mset() is called
   * without an explicit ttlMs. An explicit ttlMs always wins.
   */
  defaultTtlMs?: number;
  /**
   * Upper bound in milliseconds applied to every entry — explicit TTLs,
   * defaultTtlMs, and otherwise-permanent entries are all capped to this.
   */
  maxTtlMs?: number;
}
```

Change `MemoryAdapterOptions` in the same file to:

```ts
export interface MemoryAdapterOptions extends AdapterTtlOptions {}
```

In `packages/core/src/base-cache-adapter.ts`, add the import, constructor, and helper (keep all existing methods unchanged):

```ts
import type {
  AdapterTtlOptions,
  CacheAdapter,
  CacheEntry,
  CacheSetEntry,
  TtlResult,
} from "./types.js";

export abstract class BaseCacheAdapter implements CacheAdapter {
  abstract readonly name: string;
  private readonly defaultTtlMs?: number;
  private readonly maxTtlMs?: number;

  constructor(ttlOptions: AdapterTtlOptions = {}) {
    this.defaultTtlMs = ttlOptions.defaultTtlMs;
    this.maxTtlMs = ttlOptions.maxTtlMs;
  }

  /**
   * Resolve the effective TTL: explicit ttlMs wins over defaultTtlMs;
   * maxTtlMs caps the result (and bounds permanent entries).
   * Returns undefined for "no expiry".
   */
  protected resolveTtl(ttlMs?: number): number | undefined {
    const requested = ttlMs ?? this.defaultTtlMs;
    if (this.maxTtlMs === undefined) return requested;
    if (requested === undefined) return this.maxTtlMs;
    return Math.min(requested, this.maxTtlMs);
  }

  // ... existing abstract declarations and default implementations unchanged
}
```

In `packages/core/src/index.ts`, add `AdapterTtlOptions` to the type re-exports from `./types.js`.

- [ ] **Step 4: Migrate MemoryAdapter to `resolveTtl`**

In `packages/core/src/memory-adapter.ts`, delete the `private readonly defaultTtlMs?: number;` field and the `this.defaultTtlMs = options.defaultTtlMs;` line, change `super();` to `super(options);`, and change `set` to:

```ts
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/require-await
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const effectiveTtl = this.resolveTtl(ttlMs);
    if (effectiveTtl !== undefined) {
      // ttlMs <= 0 means already expired — don't store
      if (effectiveTtl <= 0) return;
      this.cache.set(key, value, effectiveTtl / 1000);
    } else {
      this.cache.set(key, value, 0);
    }
  }
```

- [ ] **Step 5: Migrate Redis, SQLite, and Memcache adapters**

In each adapter:

1. Change the options interface to extend `AdapterTtlOptions` and remove its own `defaultTtlMs?: number;` member. Example for Redis (`packages/redis/src/redis-adapter.ts`):

```ts
import type {
  AdapterTtlOptions,
  CacheEntry,
  CacheSetEntry,
} from "@ziggurat-cache/core";

export interface RedisAdapterOptions extends AdapterTtlOptions {
  client: Redis;
  prefix?: string;
}
```

2. Delete the `private readonly defaultTtlMs?: number;` field and its constructor assignment; change `super();` to `super(options);`.
3. Replace every `const effectiveTtl = this.defaultTtlMs ?? ttlMs;` with `const effectiveTtl = this.resolveTtl(ttlMs);` (in `set`) and every `const effectiveTtl = this.defaultTtlMs ?? entry.ttlMs;` with `const effectiveTtl = this.resolveTtl(entry.ttlMs);` (in `mset`).

Apply the identical pattern to `packages/sqlite/src/sqlite-adapter.ts` (interface `SQLiteAdapterOptions extends AdapterTtlOptions`, keeping `db`, `tableName`, `namespace`) and `packages/memcache/src/memcache-adapter.ts` (interface `MemcacheAdapterOptions extends AdapterTtlOptions`, keeping `client`, `prefix`).

- [ ] **Step 6: Update existing tests that encode the old precedence**

Four unit tests assert "defaultTtlMs over caller-provided ttlMs" — invert each to assert the explicit TTL wins, and add a `maxTtlMs` test alongside:

`packages/core/tests/unit/memory-adapter.test.ts:150` — replace the test body of `"should use defaultTtlMs over caller-provided ttlMs"` with:

```ts
it("should use caller-provided ttlMs over defaultTtlMs", async () => {
  const a = new MemoryAdapter({ defaultTtlMs: 5000 });
  await a.set("k", "v", 60_000);
  const ttl = await a.getTtl("k");
  expect(ttl.kind).toBe("expiring");
  if (ttl.kind === "expiring") {
    expect(ttl.ttlMs).toBeGreaterThan(5000);
    expect(ttl.ttlMs).toBeLessThanOrEqual(60_000);
  }
});

it("should cap ttlMs at maxTtlMs", async () => {
  const a = new MemoryAdapter({ maxTtlMs: 5000 });
  await a.set("k", "v", 60_000);
  const ttl = await a.getTtl("k");
  expect(ttl.kind).toBe("expiring");
  if (ttl.kind === "expiring") {
    expect(ttl.ttlMs).toBeLessThanOrEqual(5000);
  }
});
```

Apply the same inversion (explicit-wins) and the same added `maxTtlMs` cap test to:

- `packages/redis/tests/unit/redis-adapter.test.ts:179` (`"should use defaultTtlMs over caller-provided ttlMs"` — this test asserts which TTL value reaches `psetex`; assert `mockRedis.psetex` is called with the explicit value, e.g. `expect(mockRedis.psetex).toHaveBeenCalledWith("k", 60_000, expect.any(String))`)
- `packages/sqlite/tests/unit/sqlite-adapter.test.ts:314`
- `packages/memcache/tests/unit/memcache-adapter.test.ts:176` (asserts the `expires` seconds passed to `client.set`; explicit 60_000 ms → `{ expires: 60 }`)

`packages/core/tests/integration/multi-layer.test.ts:140` — replace `"should use adapter defaultTtlMs for backfill instead of source TTL"` (which constructs `new MemoryAdapter({ defaultTtlMs: 1000 })` as L1) with:

```ts
it("should cap backfill TTL at adapter maxTtlMs", async () => {
  const l1 = new MemoryAdapter({ maxTtlMs: 1000 });
  const l2 = new MemoryAdapter();
  await l2.set("k", "v", 600_000);
  const cache = new CacheManager({ layers: [l1, l2], syncBackfill: true });

  await cache.get("k");

  const l1Ttl = await l1.getTtl("k");
  expect(l1Ttl.kind).toBe("expiring");
  if (l1Ttl.kind === "expiring") {
    expect(l1Ttl.ttlMs).toBeLessThanOrEqual(1000);
  }
});
```

Keep the test at line 164 (`"should fall back to remaining TTL when adapter has no defaultTtlMs"`) — it still passes under the new semantics.

- [ ] **Step 7: Run everything**

Run: `pnpm build && pnpm test && pnpm typecheck && pnpm lint`
Expected: all green. If any other test trips on the precedence change, it encodes the old behavior — invert it the same way.

- [ ] **Step 8: Commit**

```bash
git add packages/core packages/redis packages/sqlite packages/memcache
git commit -m "feat(core)!: explicit ttlMs now wins over defaultTtlMs; add maxTtlMs cap

BREAKING CHANGE: defaultTtlMs is now a fallback (ttlMs ?? defaultTtlMs)
instead of overriding explicit TTLs. Use the new maxTtlMs option to cap
per-layer TTLs (e.g. short-lived L1 in multi-layer setups)."
```

---

### Task 4: Emit error events for failed backfill writes (Finding 4, High)

**Files:**

- Modify: `packages/core/src/types.ts:69-77` (operation union)
- Modify: `packages/core/src/cache-manager.ts:85-108, 280-310`
- Test: `packages/core/tests/unit/cache-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the `describe("error", ...)` block in `packages/core/tests/unit/cache-manager.test.ts`:

```ts
it("should emit error event when a backfill write fails on get", async () => {
  const l1 = new MemoryAdapter();
  vi.spyOn(l1, "set").mockRejectedValue(new Error("l1 down"));
  const l2 = new MemoryAdapter();
  await l2.set("k", "v");
  const cache = new CacheManager({ layers: [l1, l2], syncBackfill: true });
  const errors: CacheErrorEvent[] = [];
  cache.on("error", (e) => errors.push(e));

  const entry = await cache.get("k");

  expect(entry?.value).toBe("v");
  expect(errors).toHaveLength(1);
  expect(errors[0].operation).toBe("backfill");
  expect(errors[0].layerName).toBe("memory");
  expect(errors[0].layerIndex).toBe(0);
});

it("should emit error event when a backfill write fails on mget", async () => {
  const l1 = new MemoryAdapter();
  vi.spyOn(l1, "mset").mockRejectedValue(new Error("l1 down"));
  const l2 = new MemoryAdapter();
  await l2.set("k1", "v1");
  const cache = new CacheManager({ layers: [l1, l2], syncBackfill: true });
  const errors: CacheErrorEvent[] = [];
  cache.on("error", (e) => errors.push(e));

  const result = await cache.mget(["k1"]);

  expect(result.get("k1")?.value).toBe("v1");
  expect(errors).toHaveLength(1);
  expect(errors[0].operation).toBe("backfill");
});
```

Import `CacheErrorEvent` from `../../src/index.js` at the top of the file if not already imported.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ziggurat-cache/core test -- cache-manager`
Expected: FAIL — zero error events emitted; also a type error because `"backfill"` is not in the operation union.

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, add `"backfill"` to `CacheErrorEvent["operation"]`:

```ts
  operation:
    | "get"
    | "set"
    | "delete"
    | "has"
    | "getTtl"
    | "mget"
    | "mset"
    | "mdel"
    | "backfill";
```

In `packages/core/src/cache-manager.ts` `get()`, replace the backfill block (lines 91-95) with:

```ts
const backfillPromise = Promise.allSettled(
  backfillLayers.map((layer) => layer.set(nsKey, entry.value, remainingTtlMs)),
).then((results) => {
  this.emitWriteErrors(results, key, "backfill");
});
```

(`emitWriteErrors` indexes `results[i]` against `this.layers[i]`; `backfillLayers` is `this.layers.slice(0, i)`, so the indices align.)

In `mget()`, replace the backfill `Promise.allSettled` (lines 290-292) with:

```ts
const backfillKeys = foundInThisLayer
  .map(({ nsKey }) => keyMap.get(nsKey))
  .filter((k): k is string => k !== undefined);
const backfillPromise = Promise.allSettled(
  backfillLayers.map((layer) => layer.mset(backfillEntries)),
).then((results) => {
  this.emitWriteErrors(results, backfillKeys.join(","), "backfill");
});
```

Note: `emitWriteErrors` already self-guards with `hasListeners("error")`, and it now runs after the writes settle, so the check happens at the right time. The `shouldEmit` guard in `get()`/`mget()` must still include `this.events.hasListeners("error")` — `get()`'s already does; `mget()`'s already does. No change needed there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ziggurat-cache/core test`
Expected: PASS, including all pre-existing tests (the `.then` chain keeps `await backfillPromise` working for `syncBackfill`).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/cache-manager.ts packages/core/tests/unit/cache-manager.test.ts
git commit -m "fix(core): emit error events when backfill writes fail"
```

---

### Task 5: Add `strictWrites` option to CacheManager (Finding 12, Medium)

**Files:**

- Modify: `packages/core/src/types.ts:148-154`
- Modify: `packages/core/src/cache-manager.ts`
- Test: `packages/core/tests/unit/cache-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("strictWrites", () => {
  function failingAdapter(): MemoryAdapter {
    const a = new MemoryAdapter();
    vi.spyOn(a, "set").mockRejectedValue(new Error("down"));
    vi.spyOn(a, "mset").mockRejectedValue(new Error("down"));
    vi.spyOn(a, "delete").mockRejectedValue(new Error("down"));
    vi.spyOn(a, "mdel").mockRejectedValue(new Error("down"));
    return a;
  }

  it("throws AggregateError when ALL layers fail a set", async () => {
    const cache = new CacheManager({
      layers: [failingAdapter(), failingAdapter()],
      strictWrites: true,
    });
    await expect(cache.set("k", "v")).rejects.toBeInstanceOf(AggregateError);
  });

  it("does not throw when at least one layer succeeds", async () => {
    const cache = new CacheManager({
      layers: [failingAdapter(), new MemoryAdapter()],
      strictWrites: true,
    });
    await expect(cache.set("k", "v")).resolves.toBeUndefined();
  });

  it("defaults to non-strict (never throws)", async () => {
    const cache = new CacheManager({ layers: [failingAdapter()] });
    await expect(cache.set("k", "v")).resolves.toBeUndefined();
  });

  it("applies to delete, mset, and mdel", async () => {
    const cache = new CacheManager({
      layers: [failingAdapter()],
      strictWrites: true,
    });
    await expect(cache.delete("k")).rejects.toBeInstanceOf(AggregateError);
    await expect(cache.mset([{ key: "k", value: "v" }])).rejects.toBeInstanceOf(
      AggregateError,
    );
    await expect(cache.mdel(["k"])).rejects.toBeInstanceOf(AggregateError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ziggurat-cache/core test -- cache-manager`
Expected: FAIL — `strictWrites` is not a valid option and nothing throws.

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, add to `CacheManagerOptions`:

```ts
  /**
   * When true, set/mset/delete/mdel throw an AggregateError if EVERY
   * layer fails the write. Default false (writes never throw; failures
   * are observable only via "error" events).
   */
  strictWrites?: boolean;
```

In `packages/core/src/cache-manager.ts`, add the field and constructor line:

```ts
  private readonly strictWrites: boolean;
  // in constructor:
  this.strictWrites = options.strictWrites ?? false;
```

Add a private helper next to `emitWriteErrors`:

```ts
  private assertWritesSucceeded(
    results: PromiseSettledResult<void>[],
    operation: CacheErrorEvent["operation"],
  ): void {
    if (!this.strictWrites || results.length === 0) return;
    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    if (failures.length === results.length) {
      throw new AggregateError(
        failures.map((f) => f.reason),
        `All ${String(results.length)} cache layer(s) failed during ${operation}`,
      );
    }
  }
```

In `set()`, `delete()`, `mset()`, and `mdel()`, after the `if (shouldEmit) { ... }` block (so events still fire first), add the corresponding call:

```ts
this.assertWritesSucceeded(results, "set"); // in set()
this.assertWritesSucceeded(results, "delete"); // in delete()
this.assertWritesSucceeded(results, "mset"); // in mset()
this.assertWritesSucceeded(results, "mdel"); // in mdel()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @ziggurat-cache/core test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/cache-manager.ts packages/core/tests/unit/cache-manager.test.ts
git commit -m "feat(core): add strictWrites option to surface total write failures"
```

---

### Task 6: Harden CacheManager constructor (Low findings: empty layers, layer array aliasing, stampede spread)

**Files:**

- Modify: `packages/core/src/cache-manager.ts:22-31`
- Test: `packages/core/tests/unit/cache-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("constructor validation", () => {
  it("throws when layers is empty", () => {
    expect(() => new CacheManager({ layers: [] })).toThrow(
      "CacheManager requires at least one layer",
    );
  });

  it("copies the layers array (later mutation of the input has no effect)", async () => {
    const adapter = new MemoryAdapter();
    const layers = [adapter];
    const cache = new CacheManager({ layers });
    layers.pop();
    await cache.set("k", "v");
    expect((await cache.get("k"))?.value).toBe("v");
  });

  it("treats stampede: { coalesce: undefined } as coalesce enabled", async () => {
    const cache = new CacheManager({
      layers: [new MemoryAdapter()],
      stampede: { coalesce: undefined },
    });
    let calls = 0;
    const factory = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return "v";
    };
    await Promise.all([cache.wrap("k", factory), cache.wrap("k", factory)]);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ziggurat-cache/core test -- cache-manager`
Expected: FAIL on all three (no throw; aliased array; coalesce disabled by explicit undefined).

- [ ] **Step 3: Implement**

Replace the constructor body in `packages/core/src/cache-manager.ts`:

```ts
  constructor(options: CacheManagerOptions) {
    if (options.layers.length === 0) {
      throw new Error("CacheManager requires at least one layer");
    }
    this.layers = [...options.layers];
    this.namespace = options.namespace;
    this.syncBackfill = options.syncBackfill ?? false;
    this.strictWrites = options.strictWrites ?? false;
    this.stampedeConfig = {
      coalesce: options.stampede?.coalesce ?? true,
    };
    this.events = options.events ?? new TypedEventEmitter<CacheEventMap>();
  }
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/core test`
Expected: PASS.

```bash
git add packages/core/src/cache-manager.ts packages/core/tests/unit/cache-manager.test.ts
git commit -m "fix(core): validate non-empty layers, copy layer array, harden stampede defaults"
```

---

### Task 7: MemoryAdapter eviction controls — `checkPeriodMs`, `maxKeys`, `close()` (Finding 5a, High)

**Files:**

- Modify: `packages/core/src/types.ts` (`MemoryAdapterOptions`)
- Modify: `packages/core/src/memory-adapter.ts`
- Test: `packages/core/tests/unit/memory-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("eviction controls", () => {
  it("rejects set beyond maxKeys", async () => {
    const a = new MemoryAdapter({ maxKeys: 2 });
    await a.set("k1", "v1");
    await a.set("k2", "v2");
    await expect(a.set("k3", "v3")).rejects.toThrow();
  });

  it("evicts expired entries periodically when checkPeriodMs is set", async () => {
    vi.useFakeTimers();
    try {
      const a = new MemoryAdapter({ checkPeriodMs: 1000 });
      await a.set("k", "v", 500);
      vi.advanceTimersByTime(2000);
      // node-cache's internal key count drops once the periodic check runs
      expect(await a.keys()).toHaveLength(0);
      a.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("close() stops the periodic check timer", () => {
    const a = new MemoryAdapter({ checkPeriodMs: 1000 });
    expect(() => a.close()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ziggurat-cache/core test -- memory-adapter`
Expected: FAIL — options not recognized, `close` does not exist.

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`:

```ts
export interface MemoryAdapterOptions extends AdapterTtlOptions {
  /**
   * Interval in ms for proactive eviction of expired entries.
   * Default 0 (disabled): expired entries are removed only when accessed,
   * so write-heavy/read-rarely workloads can grow unboundedly.
   */
  checkPeriodMs?: number;
  /** Maximum number of keys; set() throws once exceeded. Default unlimited. */
  maxKeys?: number;
}
```

In `packages/core/src/memory-adapter.ts`, update the constructor and add `close()`:

```ts
  constructor(options: MemoryAdapterOptions = {}) {
    super(options);
    this.cache = new NodeCache({
      stdTTL: 0,
      checkperiod:
        options.checkPeriodMs !== undefined ? options.checkPeriodMs / 1000 : 0,
      useClones: false,
      maxKeys: options.maxKeys ?? -1,
    });
  }

  /** Stop the periodic expiry-check timer (no-op when checkPeriodMs is unset). */
  close(): void {
    this.cache.close();
  }
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/core test`
Expected: PASS.

```bash
git add packages/core/src/types.ts packages/core/src/memory-adapter.ts packages/core/tests/unit/memory-adapter.test.ts
git commit -m "feat(core): add checkPeriodMs, maxKeys, and close() to MemoryAdapter"
```

---

### Task 8: MemoryAdapter `serialization: "json"` mode (Finding 3, High)

**Files:**

- Modify: `packages/core/src/types.ts` (`MemoryAdapterOptions`)
- Modify: `packages/core/src/memory-adapter.ts`
- Test: `packages/core/tests/unit/memory-adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
describe("serialization mode", () => {
  it("json mode returns JSON-round-tripped values (matches Redis/SQLite fidelity)", async () => {
    const a = new MemoryAdapter({ serialization: "json" });
    const date = new Date("2026-01-01T00:00:00Z");
    await a.set("k", { when: date });
    const entry = await a.get<{ when: unknown }>("k");
    expect(entry?.value.when).toBe("2026-01-01T00:00:00.000Z");
  });

  it("json mode prevents cache poisoning via mutation of returned objects", async () => {
    const a = new MemoryAdapter({ serialization: "json" });
    await a.set("k", { n: 1 });
    const first = await a.get<{ n: number }>("k");
    first!.value.n = 999;
    const second = await a.get<{ n: number }>("k");
    expect(second?.value.n).toBe(1);
  });

  it("reference mode (default) preserves object identity", async () => {
    const a = new MemoryAdapter();
    const obj = { n: 1 };
    await a.set("k", obj);
    const entry = await a.get<{ n: number }>("k");
    expect(entry?.value).toBe(obj);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @ziggurat-cache/core test -- memory-adapter`
Expected: FAIL — `serialization` option not recognized.

- [ ] **Step 3: Implement**

In `packages/core/src/types.ts`, add to `MemoryAdapterOptions`:

```ts
  /**
   * "reference" (default): store live references — fastest, but returned
   * objects can be mutated by callers (poisoning the cache) and rich types
   * (Date, Map) survive here while JSON-based layers flatten them, so
   * multi-layer reads can return different shapes per layer.
   * "json": JSON round-trip on every set/get — consistent with the Redis,
   * SQLite, and Memcache adapters and immune to caller mutation.
   */
  serialization?: "reference" | "json";
```

In `packages/core/src/memory-adapter.ts`:

```ts
  private readonly serialization: "reference" | "json";
  // in constructor:
  this.serialization = options.serialization ?? "reference";
```

Change `get` and `set` to round-trip in json mode:

```ts
  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const raw = this.cache.get<unknown>(key);
    if (raw === undefined) return null;

    const value =
      this.serialization === "json"
        ? (JSON.parse(raw as string) as T)
        : (raw as T);
    const ttl = this.cache.getTtl(key);
    return {
      value,
      expiresAt: ttl === 0 || ttl === undefined ? null : ttl,
    };
  }
```

In `set`, compute the stored value before the existing TTL logic and store `stored` instead of `value`:

```ts
const stored = this.serialization === "json" ? JSON.stringify(value) : value;
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/core test`
Expected: PASS (all pre-existing tests use the default "reference" mode and are unaffected).

```bash
git add packages/core/src/types.ts packages/core/src/memory-adapter.ts packages/core/tests/unit/memory-adapter.test.ts
git commit -m "feat(core): add json serialization mode to MemoryAdapter for cross-layer fidelity"
```

---

### Task 9: Make `RedisAdapter.flushAll()` prefix-scoped (Finding 2, High — BREAKING)

**Files:**

- Modify: `packages/redis/src/redis-adapter.ts:172-174`
- Modify: `packages/redis/tests/unit/redis-adapter.test.ts:329-333`

- [ ] **Step 1: Update the unit test to the new contract**

Replace the `flushAll` test at `packages/redis/tests/unit/redis-adapter.test.ts:329-333`:

```ts
describe("flushAll", () => {
  it("should delete only keys under the adapter prefix, never call flushdb", async () => {
    const prefixed = new RedisAdapter({ client: mockRedis, prefix: "app:" });
    await prefixed.set("k1", "v1");
    await mockRedis.set("other:k", "untouched");

    await prefixed.flushAll();

    expect(mockRedis.flushdb).not.toHaveBeenCalled();
    expect(await prefixed.get("k1")).toBeNull();
    expect(await mockRedis.get("other:k")).toBe("untouched");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ziggurat-cache/redis test -- redis-adapter`
Expected: FAIL — `flushdb` is called and `other:k` is wiped.

- [ ] **Step 3: Implement**

In `packages/redis/src/redis-adapter.ts`, delete the `flushAll` override entirely (lines 172-174). The inherited `BaseCacheAdapter.flushAll()` delegates to `clear()`, which is SCAN+DEL scoped to the prefix.

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/redis test`
Expected: PASS (contract tests exercise `flushAll` through the base implementation).

```bash
git add packages/redis/src/redis-adapter.ts packages/redis/tests/unit/redis-adapter.test.ts
git commit -m "fix(redis)!: flushAll no longer wipes the whole database

BREAKING CHANGE: RedisAdapter.flushAll() previously called FLUSHDB,
destroying every key in the database. It now deletes only keys under
the adapter's prefix (same scope as clear())."
```

---

### Task 10: Glob-escape the Redis prefix in SCAN patterns (Finding 9, Medium)

**Files:**

- Modify: `packages/redis/src/redis-adapter.ts:94-111`
- Test: `packages/redis/tests/unit/redis-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("glob escaping", () => {
  it("escapes glob metacharacters in the prefix for clear()", async () => {
    const adapter = new RedisAdapter({ client: mockRedis, prefix: "a*b:" });
    await adapter.set("k", "v");
    await adapter.clear();
    const scanCalls = (mockRedis.scan as ReturnType<typeof vi.fn>).mock.calls;
    expect(scanCalls[0][2]).toBe("a\\*b:*");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ziggurat-cache/redis test -- redis-adapter`
Expected: FAIL — pattern is `a*b:*` (unescaped).

- [ ] **Step 3: Implement**

In `packages/redis/src/redis-adapter.ts`, add a static helper and use it in both `clear()` and `keys()`:

```ts
  private static escapeGlob(literal: string): string {
    return literal.replace(/[\\*?[\]]/g, "\\$&");
  }
```

```ts
  async clear(): Promise<void> {
    const pattern = RedisAdapter.escapeGlob(this.prefix) + "*";
    // ... rest unchanged
  }

  async keys(): Promise<string[]> {
    const pattern = RedisAdapter.escapeGlob(this.prefix) + "*";
    // ... rest unchanged
  }
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/redis test`
Expected: PASS. (The mock's `scan` strips `*` for matching; if the new escaped pattern breaks the mock's naive `replaceAll("*", "")`, update the mock at `redis-adapter.test.ts:26-32` to also strip `\\` before matching: `const prefix = pattern.replaceAll("\\", "").replaceAll("*", "");`.)

```bash
git add packages/redis/src/redis-adapter.ts packages/redis/tests/unit/redis-adapter.test.ts
git commit -m "fix(redis): escape glob metacharacters in prefix for SCAN MATCH"
```

---

### Task 11: Integer-round Redis TTLs (Finding 8, Medium)

**Files:**

- Modify: `packages/redis/src/redis-adapter.ts` (`set` and `mset`)
- Test: `packages/redis/tests/unit/redis-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("rounds fractional ttlMs up to an integer for PSETEX", async () => {
  await adapter.set("k", "v", 1500.5);
  expect(mockRedis.psetex).toHaveBeenCalledWith("k", 1501, expect.any(String));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ziggurat-cache/redis test -- redis-adapter`
Expected: FAIL — called with `1500.5`.

- [ ] **Step 3: Implement**

In `set()` change the PSETEX call:

```ts
await this.client.psetex(prefixed, Math.ceil(effectiveTtl), serialized);
```

In `mset()` change the pipelined call:

```ts
pipeline.psetex(prefixed, Math.ceil(effectiveTtl), serialized);
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/redis test`
Expected: PASS.

```bash
git add packages/redis/src/redis-adapter.ts packages/redis/tests/unit/redis-adapter.test.ts
git commit -m "fix(redis): round fractional TTLs up — PSETEX requires integer milliseconds"
```

---

### Task 12: Make Redis `mget` resilient to corrupt entries (Low)

**Files:**

- Modify: `packages/redis/src/redis-adapter.ts:126-137`
- Test: `packages/redis/tests/unit/redis-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("skips corrupt JSON entries in mget instead of throwing", async () => {
  await adapter.set("good", "v1");
  await mockRedis.set("bad", "{not json");
  const result = await adapter.mget(["good", "bad"]);
  expect(result.get("good")?.value).toBe("v1");
  expect(result.has("bad")).toBe(false);
});
```

(Uses the default no-prefix `adapter` from the test file's `beforeEach` so the raw `mockRedis.set` key aligns.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ziggurat-cache/redis test -- redis-adapter`
Expected: FAIL — `JSON.parse` throws and the whole mget rejects.

- [ ] **Step 3: Implement**

In `mget()`, wrap the per-entry parse:

```ts
for (let i = 0; i < keys.length; i++) {
  const [err, raw] = results[i] as [Error | null, string | null];
  if (err || raw === null) continue;

  let entry: CacheEntry<T>;
  try {
    entry = JSON.parse(raw) as CacheEntry<T>;
  } catch {
    // Corrupt/legacy payload — treat as a miss rather than failing the batch
    continue;
  }
  if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
    continue;
  }
  map.set(keys[i], entry);
}
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/redis test`
Expected: PASS.

```bash
git add packages/redis/src/redis-adapter.ts packages/redis/tests/unit/redis-adapter.test.ts
git commit -m "fix(redis): skip corrupt entries in mget instead of failing the batch"
```

---

### Task 13: Handle memcached's 30-day TTL limit (Finding 7, Medium)

**Files:**

- Modify: `packages/memcache/src/memcache-adapter.ts:50-54`
- Test: `packages/memcache/tests/unit/memcache-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("TTLs over 30 days", () => {
  it("converts TTLs over 30 days to an absolute unix timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T00:00:00Z"));
    try {
      const sixtyDaysMs = 60 * 24 * 60 * 60 * 1000;
      await adapter.set("k", "v", sixtyDaysMs);
      const expectedAbsolute = Math.ceil((Date.now() + sixtyDaysMs) / 1000);
      expect(mockClient.set).toHaveBeenCalledWith("k", expect.any(String), {
        expires: expectedAbsolute,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
```

(Reuse the file's existing `adapter`/`mockClient` fixtures from `beforeEach`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ziggurat-cache/memcache test`
Expected: FAIL — `expires` is the relative seconds value (5,184,000), which memcached would interpret as a unix timestamp in the past, expiring the entry instantly.

- [ ] **Step 3: Implement**

In `packages/memcache/src/memcache-adapter.ts`, add a module-level constant above the class:

```ts
// Memcached interprets relative `expires` values above 30 days as an
// absolute unix timestamp, so larger TTLs must be sent as one.
const MEMCACHE_MAX_RELATIVE_EXPIRES_SEC = 60 * 60 * 24 * 30;
```

Replace the `expiresSec` computation in `set()`:

```ts
let expiresSec =
  effectiveTtl !== undefined ? Math.ceil(effectiveTtl / 1000) : 0;
if (expiresSec > MEMCACHE_MAX_RELATIVE_EXPIRES_SEC) {
  expiresSec = Math.ceil((Date.now() + effectiveTtl!) / 1000);
}
await this.client.set(prefixed, serialized, { expires: expiresSec });
```

(The non-null assertion is safe: `expiresSec > 0` implies `effectiveTtl !== undefined`. If lint rejects `!`, restructure with an explicit `effectiveTtl !== undefined` branch.)

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/memcache test`
Expected: PASS.

```bash
git add packages/memcache/src/memcache-adapter.ts packages/memcache/tests/unit/memcache-adapter.test.ts
git commit -m "fix(memcache): send TTLs over 30 days as absolute unix timestamps"
```

---

### Task 14: SQLite `purgeExpired()` (Finding 5b, High)

**Files:**

- Modify: `packages/sqlite/src/sqlite-adapter.ts`
- Test: `packages/sqlite/tests/unit/sqlite-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("purgeExpired", () => {
  it("deletes expired rows for this namespace and returns the count", async () => {
    const a = new SQLiteAdapter({ db });
    await a.set("expired1", "v", 1);
    await a.set("expired2", "v", 1);
    await a.set("alive", "v", 60_000);
    await a.set("permanent", "v");
    await new Promise((r) => setTimeout(r, 10));

    const purged = await a.purgeExpired();

    expect(purged).toBe(2);
    expect(await a.has("alive")).toBe(true);
    expect(await a.has("permanent")).toBe(true);
  });

  it("does not purge other namespaces", async () => {
    const a = new SQLiteAdapter({ db, namespace: "a" });
    const b = new SQLiteAdapter({ db, namespace: "b" });
    await a.set("k", "v", 1);
    await b.set("k", "v", 1);
    await new Promise((r) => setTimeout(r, 10));

    expect(await a.purgeExpired()).toBe(1);
    expect(await b.purgeExpired()).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ziggurat-cache/sqlite test -- sqlite-adapter`
Expected: FAIL — `purgeExpired` does not exist.

- [ ] **Step 3: Implement**

In `packages/sqlite/src/sqlite-adapter.ts`, add a prepared statement field and constructor line (this query is what the existing `idx_<table>_expires` partial index serves):

```ts
  private readonly stmtPurge: Database.Statement;
  // in constructor, after the other prepares:
  this.stmtPurge = this.db.prepare(
    `DELETE FROM ${this.tableName} WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
  );
```

Add the method:

```ts
  /**
   * Delete all expired rows for this adapter's namespace and return the
   * number of rows removed. Expired rows are otherwise only cleaned up
   * lazily on access — call this periodically in long-running processes.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async purgeExpired(): Promise<number> {
    const result = this.stmtPurge.run(this.namespace, Date.now());
    return result.changes;
  }
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/sqlite test`
Expected: PASS.

```bash
git add packages/sqlite/src/sqlite-adapter.ts packages/sqlite/tests/unit/sqlite-adapter.test.ts
git commit -m "feat(sqlite): add purgeExpired() for proactive cleanup of expired rows"
```

---

### Task 15: Chunk SQLite `mget`/`mdel` to respect bind-variable limits (Low)

**Files:**

- Modify: `packages/sqlite/src/sqlite-adapter.ts:164-218`
- Test: `packages/sqlite/tests/unit/sqlite-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe("large batches", () => {
  it("handles mget/mdel with more keys than SQLite's bind-variable limit", async () => {
    const a = new SQLiteAdapter({ db });
    const keys = Array.from({ length: 40_000 }, (_, i) => `bulk:${String(i)}`);
    await a.mset(keys.map((key) => ({ key, value: key })));

    const fetched = await a.mget(keys);
    expect(fetched.size).toBe(40_000);

    await a.mdel(keys);
    expect((await a.mget(keys.slice(0, 10))).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ziggurat-cache/sqlite test -- sqlite-adapter`
Expected: FAIL — better-sqlite3 throws `too many SQL variables` (limit is 32766).

- [ ] **Step 3: Implement**

In `packages/sqlite/src/sqlite-adapter.ts`, add above the class:

```ts
// Stay well under SQLite's bind-variable limit (32766 in current
// better-sqlite3 builds, 999 in older SQLite compiles).
const MAX_BATCH_PARAMS = 900;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size) as T[]);
  }
  return out;
}
```

Rewrite `mget` to iterate chunks and merge:

```ts
  // eslint-disable-next-line @typescript-eslint/require-await
  async mget<T>(keys: readonly string[]): Promise<Map<string, CacheEntry<T>>> {
    if (keys.length === 0) return new Map();

    const now = Date.now();
    const result = new Map<string, CacheEntry<T>>();
    for (const batch of chunk(keys, MAX_BATCH_PARAMS)) {
      const placeholders = batch.map(() => "?").join(",");
      const stmt = this.db.prepare(
        `SELECT key, value, expires_at FROM ${this.tableName}
         WHERE namespace = ? AND key IN (${placeholders})
         AND (expires_at IS NULL OR expires_at > ?)`,
      );
      const rows = stmt.all(this.namespace, ...batch, now) as Array<{
        key: string;
        value: string;
        expires_at: number | null;
      }>;
      for (const row of rows) {
        const parsed = JSON.parse(row.value) as T;
        result.set(row.key, { value: parsed, expiresAt: row.expires_at });
      }
    }
    return result;
  }
```

Rewrite `mdel` the same way:

```ts
  // eslint-disable-next-line @typescript-eslint/require-await
  async mdel(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;

    for (const batch of chunk(keys, MAX_BATCH_PARAMS)) {
      const placeholders = batch.map(() => "?").join(",");
      const stmt = this.db.prepare(
        `DELETE FROM ${this.tableName} WHERE namespace = ? AND key IN (${placeholders})`,
      );
      stmt.run(this.namespace, ...batch);
    }
  }
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/sqlite test`
Expected: PASS (the 40k-key test takes a second or two; that's fine).

```bash
git add packages/sqlite/src/sqlite-adapter.ts packages/sqlite/tests/unit/sqlite-adapter.test.ts
git commit -m "fix(sqlite): chunk mget/mdel to respect SQLite bind-variable limits"
```

---

### Task 16: Preserve Reflect metadata in `@Cached` (Finding 11, Medium)

**Files:**

- Modify: `packages/nestjs/src/cached.decorator.ts:24-35`
- Test: `packages/nestjs/tests/unit/cached-decorator.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/nestjs/tests/unit/cached-decorator.test.ts` (the file already imports `Cached`; add `import { SetMetadata } from "@nestjs/common";` and ensure `import "reflect-metadata";` is at the top):

```ts
it("preserves Reflect metadata set by other method decorators", () => {
  class Service {
    @Cached({ key: (id: string) => `k:${id}` })
    @SetMetadata("roles", ["admin"])
    async find(id: string): Promise<string> {
      return id;
    }
  }
  const descriptor = Object.getOwnPropertyDescriptor(Service.prototype, "find");
  expect(Reflect.getMetadata("roles", descriptor!.value)).toEqual(["admin"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ziggurat-cache/nestjs test`
Expected: FAIL — metadata is `undefined` because `descriptor.value` was replaced with a bare wrapper.

- [ ] **Step 3: Implement**

In `packages/nestjs/src/cached.decorator.ts`, build the wrapper as a named constant, copy metadata, then assign:

```ts
const wrapped = async function (this: any, ...args: any[]) {
  const cacheManager: CacheManager = this[cacheManagerKey];
  const cacheKey = options.key(...args);

  return cacheManager.wrap(
    cacheKey,
    () => originalMethod.apply(this, args),
    options.ttlMs,
  );
};

// Preserve metadata stamped on the original method by other decorators
// (NestJS route decorators, @SetMetadata, etc.).
if (typeof Reflect.getMetadataKeys === "function") {
  for (const metadataKey of Reflect.getMetadataKeys(originalMethod)) {
    Reflect.defineMetadata(
      metadataKey,
      Reflect.getMetadata(metadataKey, originalMethod),
      wrapped,
    );
  }
}

descriptor.value = wrapped;
return descriptor;
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/nestjs test`
Expected: PASS (all 12 tests including the new one).

```bash
git add packages/nestjs/src/cached.decorator.ts packages/nestjs/tests/unit/cached-decorator.test.ts
git commit -m "fix(nestjs): preserve Reflect metadata when @Cached wraps a method"
```

---

### Task 17: Instrument batch operations in OTel package (Low)

**Files:**

- Modify: `packages/otel/src/instrumentation.ts`
- Test: `packages/otel/tests/unit/instrumentation.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/otel/tests/unit/instrumentation.test.ts`, using the file's existing `collectMetrics`/`findMetric` helpers:

```ts
it("should record mget hit/miss counters and duration", async () => {
  const adapter = new MemoryAdapter();
  const manager = new CacheManager({ layers: [adapter] });
  const cleanup = instrumentCacheManager(manager);

  await manager.set("k1", "v1");
  await manager.mget(["k1", "k2"]);

  const collected = await collectMetrics();
  const mgetMetric = findMetric(collected, "ziggurat.cache.mget");
  expect(mgetMetric).toBeDefined();
  expect(mgetMetric!.dataPoints[0].value).toBe(1);

  cleanup();
});

it("should record mset and mdel counters", async () => {
  const adapter = new MemoryAdapter();
  const manager = new CacheManager({ layers: [adapter] });
  const cleanup = instrumentCacheManager(manager);

  await manager.mset([{ key: "k1", value: "v1" }]);
  await manager.mdel(["k1"]);

  const collected = await collectMetrics();
  expect(findMetric(collected, "ziggurat.cache.mset")).toBeDefined();
  expect(findMetric(collected, "ziggurat.cache.mdel")).toBeDefined();

  cleanup();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @ziggurat-cache/otel test`
Expected: FAIL — the metrics do not exist.

- [ ] **Step 3: Implement**

In `packages/otel/src/instrumentation.ts`, add counters after the existing ones:

```ts
const mgetCounter = meter.createCounter("ziggurat.cache.mget", {
  description: "Number of cache mget operations",
});
const msetCounter = meter.createCounter("ziggurat.cache.mset", {
  description: "Number of cache mset operations",
});
const mdelCounter = meter.createCounter("ziggurat.cache.mdel", {
  description: "Number of cache mdel operations",
});
```

And listeners before the return:

```ts
unsubscribers.push(
  cacheManager.on("mget", (e) => {
    mgetCounter.add(1, {
      "cache.hit_count": e.hitCount,
      "cache.miss_count": e.missCount,
    });
    durationHistogram.record(e.durationMs, { "cache.operation": "mget" });
  }),
);

unsubscribers.push(
  cacheManager.on("mset", (e) => {
    msetCounter.add(1);
    durationHistogram.record(e.durationMs, { "cache.operation": "mset" });
  }),
);

unsubscribers.push(
  cacheManager.on("mdel", (e) => {
    mdelCounter.add(1);
    durationHistogram.record(e.durationMs, { "cache.operation": "mdel" });
  }),
);
```

- [ ] **Step 4: Run tests, then commit**

Run: `pnpm --filter @ziggurat-cache/otel test`
Expected: PASS.

```bash
git add packages/otel/src/instrumentation.ts packages/otel/tests/unit/instrumentation.test.ts
git commit -m "feat(otel): instrument mget, mset, and mdel events"
```

---

### Task 18: Documentation sweep

**Files:**

- Modify: `README.md:95-96` (multi-layer example)
- Modify: `docs/api-reference.md:255, 340` (TTL option tables)
- Modify: `docs/getting-started.md:37-50, 100-106`
- Modify: `docs/sqlite-adapter.md:37`
- Modify: `docs/memcache-adapter.md:36`
- Modify: `docs/redis-adapter.md` (flushAll section)
- Modify: `docs/core-concepts.md` (namespace note)
- Modify: `docs/advanced-usage.md` (strictWrites, error visibility)

No tests; this task is prose. Every item below states the exact change.

- [ ] **Step 1: Update TTL semantics everywhere**

Replace every occurrence of the sentence "Takes precedence over TTL passed via `set`/`wrap`." (found in `docs/sqlite-adapter.md:37`, `docs/memcache-adapter.md:36`, `docs/api-reference.md:255`, `docs/api-reference.md:340`) with:

> Fallback TTL applied when no `ttlMs` is passed to `set`/`wrap`. An explicit `ttlMs` always wins. Use `maxTtlMs` to cap all TTLs for the layer.

In each of those option tables, add a row directly below `defaultTtlMs`:

```markdown
| `maxTtlMs` | `number` | _none_ | Upper bound applied to every entry's TTL — explicit TTLs, `defaultTtlMs`, and otherwise-permanent entries are all capped to this. |
```

- [ ] **Step 2: Update the multi-layer examples to use `maxTtlMs` for the short L1**

In `README.md:95-96` replace:

```ts
    new MemoryAdapter({ defaultTtlMs: 30_000 }), // L1: 30s TTL
    new RedisAdapter({ client: new Redis(), defaultTtlMs: 600_000 }), // L2: 10min TTL
```

with:

```ts
    new MemoryAdapter({ maxTtlMs: 30_000 }), // L1: capped at 30s
    new RedisAdapter({ client: new Redis(), defaultTtlMs: 600_000 }), // L2: 10min TTL
```

Apply the same substitution to the parallel example in `docs/getting-started.md:100-101`, and update the sentence at `docs/getting-started.md:106` to:

> Reads check L1 first. On an L1 miss, L2 is checked. If L2 has the value, it's returned and L1 is automatically backfilled with the entry's remaining TTL, capped at L1's `maxTtlMs`, so the next read is served from memory.

- [ ] **Step 3: Document the Redis flushAll change and SCAN behavior**

In `docs/redis-adapter.md`, find the section describing `flushAll`/`clear` (or add one) and state:

> `clear()` and `flushAll()` both delete only keys under the adapter's `prefix`, using incremental `SCAN` (never `FLUSHDB`). With an empty prefix this still scans and deletes every key in the database — always configure a `prefix` when the Redis database is shared.

- [ ] **Step 4: Strengthen the memcache clear() warning**

In `docs/memcache-adapter.md`, add under the options table:

> **Warning:** memcached has no way to enumerate or delete keys by prefix, so `clear()` and `flushAll()` both call `flush` — wiping **the entire memcached server**, including keys written by other applications and other `MemcacheAdapter` prefixes. Avoid calling them in shared environments.

- [ ] **Step 5: Document new core options and caveats**

In `docs/advanced-usage.md`, add a section:

````markdown
## Write-failure visibility and strictWrites

By default, `set`/`mset`/`delete`/`mdel` never throw — a layer failure (or
even all layers failing) is only observable through `"error"` events, so
register an error listener in production. To make a **total** write failure
throw instead, enable strict writes:

​`ts
const cache = new CacheManager({ layers, strictWrites: true });
// throws AggregateError if every layer rejects the write
​`

## Value fidelity across layers

`MemoryAdapter` stores live references by default, while the Redis, SQLite,
and Memcache adapters JSON round-trip values. A `Date` survives an L1 hit
but comes back as an ISO string when L2 serves the same key. If you cache
rich types in a multi-layer setup, either store plain JSON-safe data or set
`new MemoryAdapter({ serialization: "json" })` for consistent shapes (this
also prevents callers from mutating cached objects in place).

## Memory growth

- `MemoryAdapter`: expired entries are evicted lazily on access. For
  write-heavy workloads set `checkPeriodMs` (periodic eviction) and/or
  `maxKeys`; call `close()` on shutdown if `checkPeriodMs` is set.
- `SQLiteAdapter`: expired rows are removed lazily on access. Call
  `purgeExpired()` periodically in long-running processes.
````

In `docs/core-concepts.md`, add a note in the namespace section:

> Namespaces are joined with `:` and not escaped: namespace `"a"` + key `"b:c"` produces the same stored key as namespace `"a:b"` + key `"c"`. Avoid `:` in namespace values if your keys may contain it.

In `docs/sqlite-adapter.md`, add a note:

> The adapter sets `journal_mode = WAL` and `synchronous = NORMAL` on the database you pass in. WAL mode persists on the database file — use a dedicated database file for the cache if that matters.

- [ ] **Step 6: Format and commit**

Run: `pnpm format && pnpm format:check`

```bash
git add README.md docs/
git commit -m "docs: update TTL semantics, destructive-op warnings, and new option docs"
```

---

## Final verification (after all tasks)

- [ ] Run: `pnpm build && pnpm test && pnpm typecheck && pnpm lint && pnpm format:check`
      Expected: everything green.
- [ ] If Docker is available, run the functional suites against real backends: `docker compose up -d && pnpm test:functional`
      Expected: pass (these exercise the Redis SCAN/PSETEX and memcached expiry changes against real servers).
- [ ] Review `CODE_REVIEW.md` findings 1-12 against the commit log — each High/Medium finding should map to a commit. Low findings fixed: constructor hardening, Redis mget resilience, SQLite chunking, OTel batch events. Low findings deferred (documented in Task 18 instead): undefined-value semantics unification, `CacheManager.clear()` passthrough.
