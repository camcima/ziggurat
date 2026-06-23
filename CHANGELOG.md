# Changelog

## [0.2.0](https://github.com/camcima/ziggurat/compare/v0.1.2...v0.2.0) (2026-06-23)

### ⚠ BREAKING CHANGES

* **redis:** RedisAdapter.flushAll() previously called FLUSHDB,
destroying every key in the database. It now deletes only keys under
the adapter's prefix (same scope as clear()).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
* **core:** defaultTtlMs is now a fallback (ttlMs ?? defaultTtlMs)
instead of overriding explicit TTLs. Use the new maxTtlMs option to cap
per-layer TTLs (e.g. short-lived L1 in multi-layer setups).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

### Features

* **core:** add checkPeriodMs, maxKeys, and close() to MemoryAdapter ([d1dc2b0](https://github.com/camcima/ziggurat/commit/d1dc2b07961af58ad2f4863bf775ad1c7be7dc5f))
* **core:** add json serialization mode to MemoryAdapter for cross-layer fidelity ([1b77216](https://github.com/camcima/ziggurat/commit/1b77216500f0d35afe0eb328e25c526063e197f7))
* **core:** add strictWrites option to surface total write failures ([7d79667](https://github.com/camcima/ziggurat/commit/7d7966745758ef10c94c3e43147ef74ca2394843))
* **core:** explicit ttlMs now wins over defaultTtlMs; add maxTtlMs cap ([c9376c0](https://github.com/camcima/ziggurat/commit/c9376c08b903a3ba369d50d4ea3c1f147f2fe7b5))
* **otel:** instrument mget, mset, and mdel events ([0e1d15e](https://github.com/camcima/ziggurat/commit/0e1d15e752f8b32b424751b0ea7c9a501a1c1829))
* **sqlite:** add purgeExpired() for proactive cleanup of expired rows ([d3b225b](https://github.com/camcima/ziggurat/commit/d3b225babbc9637c59f8e5f7c5315b35812b9d78))

### Bug Fixes

* **core:** allow overwriting existing keys when MemoryAdapter is at maxKeys capacity ([69eb255](https://github.com/camcima/ziggurat/commit/69eb2558d13d77907909598912d2f6e25a965013))
* **core:** emit error events when backfill writes fail ([ae13328](https://github.com/camcima/ziggurat/commit/ae13328f8f8a9c74a4f61fff3c613edccb44fd27))
* **core:** reject non-finite ttlMs in resolveTtl ([ff93e29](https://github.com/camcima/ziggurat/commit/ff93e299c2579bbb0cb8b39bdc4d4bc2be80beab))
* **core:** skip storing undefined in MemoryAdapter json mode for has() consistency ([4060bb7](https://github.com/camcima/ziggurat/commit/4060bb7a9099bad4fa1e0f8fffd1c623cdaf89ea))
* **core:** validate non-empty layers, copy layer array, harden stampede defaults ([37fc26f](https://github.com/camcima/ziggurat/commit/37fc26f2ef89f3813b1c3270787be23be8fe3b7c))
* declare node >=20 engines in published packages, correct README badge ([768951e](https://github.com/camcima/ziggurat/commit/768951ec99ffca4355d66ef2a90cced1eaee18c0))
* **lint:** drop redundant type assertions flagged by typescript-eslint 8.59 ([27da5ac](https://github.com/camcima/ziggurat/commit/27da5ac3c57f32205057266dc6ff19b2771d90d9))
* **memcache:** send TTLs over 30 days as absolute unix timestamps ([938dda0](https://github.com/camcima/ziggurat/commit/938dda0a0a2ac4e0a96c6633de22eaa252702f8b))
* **memcache:** treat corrupt cache entries as misses in get ([3ebf634](https://github.com/camcima/ziggurat/commit/3ebf634ae17f52b50ee29abdd51f02f75252be17))
* **nestjs:** allow NestJS 11 in peer dependency range ([bab7ea1](https://github.com/camcima/ziggurat/commit/bab7ea1d8e13429192eb9d165066c1109b0da88b))
* **nestjs:** preserve Reflect metadata when @Cached wraps a method ([e735cdf](https://github.com/camcima/ziggurat/commit/e735cdf2bef14dea0ded77ddc6239e6cadefa490))
* **otel:** tag hit/miss counters with cache.operation for consistent aggregation ([65b37c9](https://github.com/camcima/ziggurat/commit/65b37c9485d637f63db20f389261e9037b026589))
* **redis:** escape glob metacharacters in prefix for SCAN MATCH ([cd837bc](https://github.com/camcima/ziggurat/commit/cd837bcd655ecfe9869240b4ca1bf119e7048765))
* **redis:** flushAll no longer wipes the whole database ([deac8ca](https://github.com/camcima/ziggurat/commit/deac8cae4645823487f2f83af8d745c2f6df9c2d))
* **redis:** round fractional TTLs up — PSETEX requires integer milliseconds ([07ab322](https://github.com/camcima/ziggurat/commit/07ab3223f7d060081d37945617985505c4b568ed))
* **redis:** treat corrupt cache entries as misses in get and mget ([09bd0f1](https://github.com/camcima/ziggurat/commit/09bd0f1d3746a5a5d9f6d30890c66ffeab95f583))
* **sqlite:** chunk mget/mdel to respect SQLite bind-variable limits ([759509a](https://github.com/camcima/ziggurat/commit/759509a7c402f853cae98faf75207797703a677e))
* **sqlite:** treat corrupt cache entries as misses in get and mget ([643beb5](https://github.com/camcima/ziggurat/commit/643beb5e6657f37053d28fc1b8b1652df6a55891))

## [0.1.3](https://github.com/camcima/ziggurat/compare/v0.1.2...v0.1.3) (2026-04-30)

### Bug Fixes

* **lint:** drop redundant type assertions flagged by typescript-eslint 8.59 ([27da5ac](https://github.com/camcima/ziggurat/commit/27da5ac3c57f32205057266dc6ff19b2771d90d9))

## [0.1.2](https://github.com/camcima/ziggurat/compare/v0.1.1...v0.1.2) (2026-04-06)

### Bug Fixes

* **ci:** use correct osv-scanner-action path and pin to v2.3.5 ([2cc3528](https://github.com/camcima/ziggurat/commit/2cc3528af6117864aa7a1fcd5b36590c5609ad4a))
* remove duplicate publish hook from release-it config ([4096fe7](https://github.com/camcima/ziggurat/commit/4096fe7458826e863982516343382ae8a4bbda6f))
* scope CI badge to main branch only ([f59eb2b](https://github.com/camcima/ziggurat/commit/f59eb2bfef52671c3d67da214bf7da5e98a20a45))
* use per-format types conditions in exports map to fix FalseESM ([e29a6ae](https://github.com/camcima/ziggurat/commit/e29a6ae7a026485c5f4ff6e280da98493ed20b6c))
