# @ziggurat-cache/otel

OpenTelemetry instrumentation for the [Ziggurat](https://github.com/camcima/ziggurat) multi-layer cache. Translates cache events into OTel counters and histograms.

## Installation

```bash
npm install @ziggurat-cache/core @ziggurat-cache/otel @opentelemetry/api
```

## Usage

```ts
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";
import { instrumentCacheManager } from "@ziggurat-cache/otel";

const cache = new CacheManager({
  layers: [new MemoryAdapter()],
});

// Start recording metrics
const cleanup = instrumentCacheManager(cache);

// ... use cache normally ...

// Stop recording (optional)
cleanup();
```

## Options

```ts
instrumentCacheManager(cache, {
  meterName: "my-app", // Custom OTel meter name (default: "ziggurat-cache")
});
```

## Metrics

| Metric                                 | Type      | Description                                                             |
| -------------------------------------- | --------- | ----------------------------------------------------------------------- |
| `ziggurat.cache.hit`                   | Counter   | Cache hits (attributes: `cache.layer`)                                  |
| `ziggurat.cache.miss`                  | Counter   | Cache misses                                                            |
| `ziggurat.cache.set`                   | Counter   | Cache writes                                                            |
| `ziggurat.cache.delete`                | Counter   | Cache deletes                                                           |
| `ziggurat.cache.error`                 | Counter   | Layer errors (attributes: `cache.layer`, `cache.operation`)             |
| `ziggurat.cache.backfill`              | Counter   | Backfills from lower layers (attributes: `cache.source_layer`)          |
| `ziggurat.cache.wrap.hit`              | Counter   | `wrap()` served from cache                                              |
| `ziggurat.cache.wrap.miss`             | Counter   | `wrap()` called the factory                                             |
| `ziggurat.cache.wrap.coalesce`         | Counter   | Concurrent requests coalesced                                           |
| `ziggurat.cache.duration`              | Histogram | Operation duration in ms (attributes: `cache.operation`, `cache.layer`) |
| `ziggurat.cache.wrap.factory_duration` | Histogram | Factory call duration in ms                                             |

## Prometheus Example

```ts
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { metrics } from "@opentelemetry/api";

const exporter = new PrometheusExporter({ port: 9464 });
const meterProvider = new MeterProvider({ readers: [exporter] });
metrics.setGlobalMeterProvider(meterProvider);

// Now instrumentCacheManager() will emit Prometheus metrics
const cleanup = instrumentCacheManager(cache);

// Metrics available at http://localhost:9464/metrics
```

## Requirements

- `@opentelemetry/api` >= 1.0.0 (peer dependency)

## Documentation

See the [API Reference](https://github.com/camcima/ziggurat/blob/main/docs/api-reference.md#zigguratolel) for the full event-to-metric mapping.

## License

MIT
