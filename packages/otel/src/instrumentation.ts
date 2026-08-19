import { metrics, type Attributes } from "@opentelemetry/api";
import type { CacheManager } from "@ziggurat-cache/core";

export interface InstrumentationOptions {
  meterName?: string;
}

/**
 * Merge the event's namespace into an attribute set so metrics from two
 * managers over the same meter stay distinguishable. Omitted entirely when
 * the manager has no namespace, rather than recorded as an empty string.
 */
function withNamespace(
  namespace: string | undefined,
  attributes: Attributes = {},
): Attributes {
  return namespace === undefined
    ? attributes
    : { ...attributes, "cache.namespace": namespace };
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
      const attributes = withNamespace(e.namespace, {
        "cache.layer": e.layerName,
        "cache.operation": "get",
      });
      hitCounter.add(1, attributes);
      durationHistogram.record(e.durationMs, attributes);
    }),
  );

  unsubscribers.push(
    cacheManager.on("miss", (e) => {
      const attributes = withNamespace(e.namespace, {
        "cache.operation": "get",
      });
      missCounter.add(1, attributes);
      durationHistogram.record(e.durationMs, attributes);
    }),
  );

  unsubscribers.push(
    cacheManager.on("set", (e) => {
      setCounter.add(1, withNamespace(e.namespace));
      durationHistogram.record(
        e.durationMs,
        withNamespace(e.namespace, { "cache.operation": "set" }),
      );
    }),
  );

  unsubscribers.push(
    cacheManager.on("delete", (e) => {
      deleteCounter.add(1, withNamespace(e.namespace));
      durationHistogram.record(
        e.durationMs,
        withNamespace(e.namespace, { "cache.operation": "delete" }),
      );
    }),
  );

  unsubscribers.push(
    cacheManager.on("error", (e) => {
      errorCounter.add(
        1,
        withNamespace(e.namespace, {
          "cache.layer": e.layerName,
          "cache.operation": e.operation,
        }),
      );
    }),
  );

  unsubscribers.push(
    cacheManager.on("backfill", (e) => {
      backfillCounter.add(
        1,
        withNamespace(e.namespace, {
          "cache.source_layer": e.sourceLayerName,
        }),
      );
    }),
  );

  unsubscribers.push(
    cacheManager.on("wrap:hit", (e) => {
      wrapHitCounter.add(1, withNamespace(e.namespace));
      durationHistogram.record(
        e.durationMs,
        withNamespace(e.namespace, { "cache.operation": "wrap" }),
      );
    }),
  );

  unsubscribers.push(
    cacheManager.on("wrap:miss", (e) => {
      wrapMissCounter.add(1, withNamespace(e.namespace));
      durationHistogram.record(
        e.durationMs,
        withNamespace(e.namespace, { "cache.operation": "wrap" }),
      );
      factoryDurationHistogram.record(
        e.factoryDurationMs,
        withNamespace(e.namespace),
      );
    }),
  );

  unsubscribers.push(
    cacheManager.on("wrap:coalesce", (e) => {
      wrapCoalesceCounter.add(1, withNamespace(e.namespace));
    }),
  );

  unsubscribers.push(
    cacheManager.on("mget", (e) => {
      const attributes = withNamespace(e.namespace, {
        "cache.operation": "mget",
      });
      mgetCounter.add(1, withNamespace(e.namespace));
      if (e.hitCount > 0) {
        hitCounter.add(e.hitCount, attributes);
      }
      if (e.missCount > 0) {
        missCounter.add(e.missCount, attributes);
      }
      durationHistogram.record(e.durationMs, attributes);
    }),
  );

  unsubscribers.push(
    cacheManager.on("mset", (e) => {
      msetCounter.add(1, withNamespace(e.namespace));
      durationHistogram.record(
        e.durationMs,
        withNamespace(e.namespace, { "cache.operation": "mset" }),
      );
    }),
  );

  unsubscribers.push(
    cacheManager.on("mdel", (e) => {
      mdelCounter.add(1, withNamespace(e.namespace));
      durationHistogram.record(
        e.durationMs,
        withNamespace(e.namespace, { "cache.operation": "mdel" }),
      );
    }),
  );

  return () => {
    for (const unsub of unsubscribers) {
      unsub();
    }
  };
}
