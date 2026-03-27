import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MeterProvider,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { metrics } from "@opentelemetry/api";
import {
  CacheManager,
  MemoryAdapter,
  BaseCacheAdapter,
} from "@ziggurat/core";
import type { CacheEntry } from "@ziggurat/core";
import { instrumentCacheManager } from "../../src/instrumentation.js";

describe("instrumentCacheManager", () => {
  let exporter: InMemoryMetricExporter;
  let reader: PeriodicExportingMetricReader;
  let meterProvider: MeterProvider;

  beforeEach(() => {
    exporter = new InMemoryMetricExporter();
    reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 100,
    });
    meterProvider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(meterProvider);
  });

  afterEach(async () => {
    metrics.disable();
    await reader.shutdown();
    await meterProvider.shutdown();
  });

  async function collectMetrics() {
    await reader.forceFlush();
    return exporter.getMetrics();
  }

  function findMetric(
    resourceMetrics: ReturnType<InMemoryMetricExporter["getMetrics"]>,
    name: string,
  ) {
    for (const rm of resourceMetrics) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) {
          if (m.descriptor.name === name) {
            return m;
          }
        }
      }
    }
    return undefined;
  }

  it("should record hit counter on cache hit", async () => {
    const adapter = new MemoryAdapter();
    const manager = new CacheManager({ layers: [adapter] });
    const cleanup = instrumentCacheManager(manager);

    await manager.set("key1", "value1");
    await manager.get("key1");

    const collected = await collectMetrics();
    const hitMetric = findMetric(collected, "ziggurat.cache.hit");
    expect(hitMetric).toBeDefined();
    expect(hitMetric!.dataPoints.length).toBeGreaterThan(0);
    expect(hitMetric!.dataPoints[0].value).toBe(1);

    cleanup();
  });

  it("should record miss counter on cache miss", async () => {
    const adapter = new MemoryAdapter();
    const manager = new CacheManager({ layers: [adapter] });
    const cleanup = instrumentCacheManager(manager);

    await manager.get("nonexistent");

    const collected = await collectMetrics();
    const missMetric = findMetric(collected, "ziggurat.cache.miss");
    expect(missMetric).toBeDefined();
    expect(missMetric!.dataPoints[0].value).toBe(1);

    cleanup();
  });

  it("should record set counter", async () => {
    const adapter = new MemoryAdapter();
    const manager = new CacheManager({ layers: [adapter] });
    const cleanup = instrumentCacheManager(manager);

    await manager.set("key1", "value1");

    const collected = await collectMetrics();
    const setMetric = findMetric(collected, "ziggurat.cache.set");
    expect(setMetric).toBeDefined();
    expect(setMetric!.dataPoints[0].value).toBe(1);

    cleanup();
  });

  it("should record delete counter", async () => {
    const adapter = new MemoryAdapter();
    const manager = new CacheManager({ layers: [adapter] });
    const cleanup = instrumentCacheManager(manager);

    await manager.set("key1", "value1");
    await manager.delete("key1");

    const collected = await collectMetrics();
    const deleteMetric = findMetric(collected, "ziggurat.cache.delete");
    expect(deleteMetric).toBeDefined();
    expect(deleteMetric!.dataPoints[0].value).toBe(1);

    cleanup();
  });

  it("should record wrap.hit and wrap.miss counters", async () => {
    const adapter = new MemoryAdapter();
    const manager = new CacheManager({ layers: [adapter] });
    const cleanup = instrumentCacheManager(manager);

    // First wrap: miss (factory called)
    await manager.wrap("key1", async () => "value1");
    // Second wrap: hit (cached)
    await manager.wrap("key1", async () => "value2");

    const collected = await collectMetrics();
    const wrapMiss = findMetric(collected, "ziggurat.cache.wrap.miss");
    const wrapHit = findMetric(collected, "ziggurat.cache.wrap.hit");
    expect(wrapMiss).toBeDefined();
    expect(wrapMiss!.dataPoints[0].value).toBe(1);
    expect(wrapHit).toBeDefined();
    expect(wrapHit!.dataPoints[0].value).toBe(1);

    cleanup();
  });

  it("should record duration histogram", async () => {
    const adapter = new MemoryAdapter();
    const manager = new CacheManager({ layers: [adapter] });
    const cleanup = instrumentCacheManager(manager);

    await manager.set("key1", "value1");
    await manager.get("key1");

    const collected = await collectMetrics();
    const duration = findMetric(collected, "ziggurat.cache.duration");
    expect(duration).toBeDefined();
    expect(duration!.dataPoints.length).toBeGreaterThan(0);

    cleanup();
  });

  it("should record factory duration histogram on wrap miss", async () => {
    const adapter = new MemoryAdapter();
    const manager = new CacheManager({ layers: [adapter] });
    const cleanup = instrumentCacheManager(manager);

    await manager.wrap("key1", async () => "value1");

    const collected = await collectMetrics();
    const factoryDuration = findMetric(
      collected,
      "ziggurat.cache.wrap.factory_duration",
    );
    expect(factoryDuration).toBeDefined();
    expect(factoryDuration!.dataPoints.length).toBeGreaterThan(0);

    cleanup();
  });

  it("should record backfill counter on L2 hit", async () => {
    const l1 = new MemoryAdapter();
    const l2 = new MemoryAdapter();
    const manager = new CacheManager({
      layers: [l1, l2],
      syncBackfill: true,
    });
    const cleanup = instrumentCacheManager(manager);

    await l2.set("key1", "value1");
    await manager.get("key1");

    const collected = await collectMetrics();
    const backfill = findMetric(collected, "ziggurat.cache.backfill");
    expect(backfill).toBeDefined();
    expect(backfill!.dataPoints[0].value).toBe(1);

    cleanup();
  });

  it("should stop recording after cleanup", async () => {
    const adapter = new MemoryAdapter();
    const manager = new CacheManager({ layers: [adapter] });
    const cleanup = instrumentCacheManager(manager);

    await manager.set("key1", "value1");
    await manager.get("key1");

    cleanup();

    // These operations should not be recorded
    await manager.set("key2", "value2");
    await manager.get("key2");

    const collected = await collectMetrics();
    const hitMetric = findMetric(collected, "ziggurat.cache.hit");
    // Should only have 1 hit (from before cleanup), not 2
    expect(hitMetric).toBeDefined();
    expect(hitMetric!.dataPoints[0].value).toBe(1);
  });

  it("should record error counter on write-path layer failure", async () => {
    const failing = new (class extends BaseCacheAdapter {
      readonly name = "failing";
      async get<T>(): Promise<CacheEntry<T> | null> {
        throw new Error("get failed");
      }
      async set(): Promise<void> {
        throw new Error("set failed");
      }
      async delete(): Promise<void> {
        throw new Error("delete failed");
      }
      async clear(): Promise<void> {
        throw new Error("clear failed");
      }
    })();
    const healthy = new MemoryAdapter();
    const manager = new CacheManager({ layers: [failing, healthy] });
    const cleanup = instrumentCacheManager(manager);

    await manager.set("key1", "value1");

    const collected = await collectMetrics();
    const errorMetric = findMetric(collected, "ziggurat.cache.error");
    expect(errorMetric).toBeDefined();
    expect(errorMetric!.dataPoints.length).toBeGreaterThan(0);

    // Verify the error metric has the correct attributes
    const dp = errorMetric!.dataPoints[0];
    expect(dp.value).toBe(1);
    expect(dp.attributes["cache.layer"]).toBe("failing");
    expect(dp.attributes["cache.operation"]).toBe("set");

    cleanup();
  });

  it("should use custom meter name", async () => {
    const adapter = new MemoryAdapter();
    const manager = new CacheManager({ layers: [adapter] });
    const cleanup = instrumentCacheManager(manager, {
      meterName: "my-app",
    });

    await manager.set("key1", "value1");
    await manager.get("key1");

    const collected = await collectMetrics();
    // Verify metrics are recorded under the custom meter
    const hitMetric = findMetric(collected, "ziggurat.cache.hit");
    expect(hitMetric).toBeDefined();

    cleanup();
  });
});
