/**
 * Consumer-perspective smoke test for the built bundles.
 *
 * The repo's own toolchain needs Node >= 22.13 (pnpm 11 refuses to install on
 * anything older), so `pnpm test` cannot run on the Node 20 floor the packages
 * advertise in `engines`. This script loads the built output the way a
 * consumer does — no pnpm, no vitest, just `node` — which is what lets CI
 * verify that floor on the runtime itself.
 *
 * Run after `pnpm build`:  node scripts/smoke-test.mjs
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// The adapter packages import their backends as types only, so none of them
// pulls a native module at runtime and all six load on any supported Node.
const PACKAGES = ["core", "redis", "memcache", "sqlite", "otel", "nestjs"];

const distPath = (pkg, file) =>
  path.join(repoRoot, "packages", pkg, "dist", file);

// 1. Both bundles of every package load and export something.
for (const pkg of PACKAGES) {
  const esm = await import(pathToFileURL(distPath(pkg, "index.js")).href);
  assert.ok(Object.keys(esm).length > 0, `${pkg}: ESM bundle exported nothing`);
  const cjs = require(distPath(pkg, "index.cjs"));
  assert.ok(Object.keys(cjs).length > 0, `${pkg}: CJS bundle exported nothing`);
}

// 2. The core API runs, rather than merely parsing.
const { CacheManager, MemoryAdapter } = await import(
  pathToFileURL(distPath("core", "index.js")).href
);

const cache = new CacheManager({
  namespace: "smoke",
  layers: [
    new MemoryAdapter({ defaultTtlMs: 5_000 }), // L1: short
    new MemoryAdapter({ defaultTtlMs: 60_000 }), // L2: long
  ],
  syncBackfill: true,
});
const [l1] = cache.getLayers();
const nsKey = "smoke:user:1";

let factoryCalls = 0;
const results = await Promise.all(
  Array.from({ length: 5 }, () =>
    cache.wrap("user:1", async () => {
      factoryCalls++;
      return { id: 1, name: "Alice" };
    }),
  ),
);
assert.equal(
  factoryCalls,
  1,
  "concurrent misses should coalesce into one call",
);
for (const value of results) {
  assert.deepEqual(value, { id: 1, name: "Alice" });
}

// Evict L1 only: the next read hits L2 and backfills L1 under L1's own policy.
await l1.delete(nsKey);
assert.equal(await l1.get(nsKey), null);

const backfilled = await cache.get("user:1");
assert.deepEqual(backfilled.value, { id: 1, name: "Alice" });

const l1Ttl = await l1.getTtl(nsKey);
assert.equal(l1Ttl.kind, "expiring");
assert.ok(
  l1Ttl.ttlMs <= 5_000,
  `backfill should apply L1's own TTL, got ${l1Ttl.ttlMs}ms`,
);

await cache.delete("user:1");
assert.equal(await cache.get("user:1"), null);

console.log(
  `ok — ${PACKAGES.length} packages load (ESM + CJS) and @ziggurat-cache/core works on Node ${process.version}`,
);
