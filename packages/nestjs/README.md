# @ziggurat-cache/nestjs

NestJS module and `@Cached()` decorator for the [Ziggurat](https://github.com/camcima/ziggurat) multi-layer cache.

## Installation

```bash
npm install @ziggurat-cache/core @ziggurat-cache/nestjs
```

## Setup

```ts
// app.module.ts
import { Module } from "@nestjs/common";
import { ZigguratModule } from "@ziggurat-cache/nestjs";
import { MemoryAdapter } from "@ziggurat-cache/core";

@Module({
  imports: [
    ZigguratModule.forRoot({
      layers: [new MemoryAdapter({ defaultTtlMs: 300_000 })],
    }),
  ],
})
export class AppModule {}
```

## @Cached() Decorator

Zero-boilerplate method-level caching with full type safety:

```ts
import { Injectable } from "@nestjs/common";
import { Cached } from "@ziggurat-cache/nestjs";

@Injectable()
export class UserService {
  @Cached({
    key: (id: string) => `user:profile:${id}`,
    ttlMs: 300_000,
  })
  async getUserProfile(id: string) {
    return this.db.users.findById(id);
  }
}
```

The decorator wraps the method with `CacheManager.wrap()`, providing stampede protection and multi-layer caching automatically.

## Async Configuration

```ts
ZigguratModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    layers: [new MemoryAdapter({ defaultTtlMs: config.get("CACHE_TTL") })],
  }),
});
```

## Accessing CacheManager Directly

```ts
import { Injectable, Inject } from "@nestjs/common";
import { CACHE_MANAGER } from "@ziggurat-cache/nestjs";
import { CacheManager } from "@ziggurat-cache/core";

@Injectable()
export class MyService {
  constructor(@Inject(CACHE_MANAGER) private cache: CacheManager) {}

  async invalidate(userId: string) {
    await this.cache.delete(`user:profile:${userId}`);
  }
}
```

## Requirements

- `@nestjs/common` >= 10.0.0 (peer dependency)
- `@nestjs/core` >= 10.0.0 (peer dependency)
- `reflect-metadata` >= 0.2.0 (peer dependency)

## Documentation

See the [NestJS Integration guide](https://github.com/camcima/ziggurat/blob/main/docs/nestjs-integration.md) for async configuration, decorator options, and testing patterns.

## License

MIT
