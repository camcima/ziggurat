import { metrics } from "@opentelemetry/api";
import type { CacheManager } from "@ziggurat-cache/core";

export interface InstrumentationOptions {
  meterName?: string;
}

export function instrumentCacheManager(
  cacheManager: CacheManager,
  options?: InstrumentationOptions,
): () => void {
  const meter = metrics.getMeter(options?.meterName ?? "ziggurat");

  const hitCounter = meter.createCounter("ziggurat.cache.hit", {
    description: "Number of cache hits",
  });
  const missCounter = meter.createCounter("ziggurat.cache.miss", {
    description: "Number of cache misses",
  });
  const setCounter = meter.createCounter("ziggurat.cache.set", {
    description: "Number of cache set operations",
  });
  const deleteCounter = meter.createCounter("ziggurat.cache.delete", {
    description: "Number of cache delete operations",
  });
  const errorCounter = meter.createCounter("ziggurat.cache.error", {
    description: "Number of cache layer errors",
  });
  const backfillCounter = meter.createCounter("ziggurat.cache.backfill", {
    description: "Number of cache backfill events",
  });
  const wrapHitCounter = meter.createCounter("ziggurat.cache.wrap.hit", {
    description: "Number of wrap cache hits",
  });
  const wrapMissCounter = meter.createCounter("ziggurat.cache.wrap.miss", {
    description: "Number of wrap cache misses (factory called)",
  });
  const wrapCoalesceCounter = meter.createCounter(
    "ziggurat.cache.wrap.coalesce",
    {
      description: "Number of coalesced wrap requests (stampede prevention)",
    },
  );
  const durationHistogram = meter.createHistogram("ziggurat.cache.duration", {
    description: "Duration of cache operations in milliseconds",
    unit: "ms",
  });
  const factoryDurationHistogram = meter.createHistogram(
    "ziggurat.cache.wrap.factory_duration",
    {
      description: "Duration of wrap factory calls in milliseconds",
      unit: "ms",
    },
  );
  const mgetCounter = meter.createCounter("ziggurat.cache.mget", {
    description: "Number of cache mget operations",
  });
  const msetCounter = meter.createCounter("ziggurat.cache.mset", {
    description: "Number of cache mset operations",
  });
  const mdelCounter = meter.createCounter("ziggurat.cache.mdel", {
    description: "Number of cache mdel operations",
  });

  const unsubscribers: Array<() => void> = [];

  unsubscribers.push(
    cacheManager.on("hit", (e) => {
      hitCounter.add(1, {
        "cache.layer": e.layerName,
        "cache.operation": "get",
      });
      durationHistogram.record(e.durationMs, {
        "cache.operation": "get",
        "cache.layer": e.layerName,
      });
    }),
  );

  unsubscribers.push(
    cacheManager.on("miss", (e) => {
      missCounter.add(1, { "cache.operation": "get" });
      durationHistogram.record(e.durationMs, { "cache.operation": "get" });
    }),
  );

  unsubscribers.push(
    cacheManager.on("set", (e) => {
      setCounter.add(1);
      durationHistogram.record(e.durationMs, { "cache.operation": "set" });
    }),
  );

  unsubscribers.push(
    cacheManager.on("delete", (e) => {
      deleteCounter.add(1);
      durationHistogram.record(e.durationMs, {
        "cache.operation": "delete",
      });
    }),
  );

  unsubscribers.push(
    cacheManager.on("error", (e) => {
      errorCounter.add(1, {
        "cache.layer": e.layerName,
        "cache.operation": e.operation,
      });
    }),
  );

  unsubscribers.push(
    cacheManager.on("backfill", (e) => {
      backfillCounter.add(1, { "cache.source_layer": e.sourceLayerName });
    }),
  );

  unsubscribers.push(
    cacheManager.on("wrap:hit", (e) => {
      wrapHitCounter.add(1);
      durationHistogram.record(e.durationMs, { "cache.operation": "wrap" });
    }),
  );

  unsubscribers.push(
    cacheManager.on("wrap:miss", (e) => {
      wrapMissCounter.add(1);
      durationHistogram.record(e.durationMs, { "cache.operation": "wrap" });
      factoryDurationHistogram.record(e.factoryDurationMs);
    }),
  );

  unsubscribers.push(
    cacheManager.on("wrap:coalesce", () => {
      wrapCoalesceCounter.add(1);
    }),
  );

  unsubscribers.push(
    cacheManager.on("mget", (e) => {
      mgetCounter.add(1);
      if (e.hitCount > 0) {
        hitCounter.add(e.hitCount, { "cache.operation": "mget" });
      }
      if (e.missCount > 0) {
        missCounter.add(e.missCount, { "cache.operation": "mget" });
      }
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

  return () => {
    for (const unsub of unsubscribers) {
      unsub();
    }
  };
}
