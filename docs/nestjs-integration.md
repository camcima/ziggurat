# NestJS Integration

The `@ziggurat/nestjs` package provides first-class NestJS support with a dynamic module for dependency injection and a `@Cached()` method decorator for declarative caching.

## Installation

```bash
npm install @ziggurat/core @ziggurat/nestjs
```

Peer dependencies: `@nestjs/common` >= 10.x, `@nestjs/core` >= 10.x, `reflect-metadata`.

## Module Registration

### `forRoot` — Synchronous

Use when your cache configuration is known at import time:

```ts
import { Module } from "@nestjs/common";
import { ZigguratModule } from "@ziggurat/nestjs";
import { MemoryAdapter } from "@ziggurat/core";

@Module({
  imports: [
    ZigguratModule.forRoot({
      layers: [new MemoryAdapter()],
    }),
  ],
})
export class AppModule {}
```

### `forRootAsync` — Asynchronous

Use when your configuration depends on other providers (e.g., `ConfigService`, environment variables):

```ts
import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { ZigguratModule } from "@ziggurat/nestjs";
import { MemoryAdapter } from "@ziggurat/core";
import { RedisAdapter } from "@ziggurat/redis";
import Redis from "ioredis";

@Module({
  imports: [
    ConfigModule.forRoot(),
    ZigguratModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        layers: [
          new MemoryAdapter({
            defaultTtlMs: config.get<number>("CACHE_DEFAULT_TTL", 300_000),
          }),
          new RedisAdapter({
            client: new Redis(config.get<string>("REDIS_URL")),
            prefix: "myapp:",
          }),
        ],
        stampede: {
          coalesce: config.get<boolean>("CACHE_COALESCE", true),
        },
      }),
    }),
  ],
})
export class AppModule {}
```

### Global Registration

Both `forRoot` and `forRootAsync` register the module **globally**. The `CacheManager` is available for injection in any module without re-importing `ZigguratModule`.

## The `@Cached()` Decorator

The `@Cached()` decorator wraps a service method with `CacheManager.wrap()`. It:

1. Computes a cache key from the method arguments.
2. Checks the cache. On a hit, returns the cached value without executing the method body.
3. On a miss, executes the original method, caches the result, and returns it.
4. Includes stampede protection — concurrent calls for the same key share a single execution.

### Basic Usage

```ts
import { Injectable } from "@nestjs/common";
import { Cached } from "@ziggurat/nestjs";

@Injectable()
export class UserService {
  @Cached({
    key: (id: string) => `user:profile:${id}`,
    ttlMs: 300_000, // 5 minutes
  })
  async getUserProfile(id: string) {
    // Only executes on cache miss
    return this.db.users.findById(id);
  }
}
```

### Options

| Property | Type                         | Description                                                       |
| -------- | ---------------------------- | ----------------------------------------------------------------- |
| `key`    | `(...args: any[]) => string` | Receives the method's arguments and returns the cache key string. |
| `ttlMs`  | `number`                     | _(optional)_ TTL in milliseconds. Omit for no expiration.         |

### Multi-Argument Key Functions

The key function receives all method arguments:

```ts
@Injectable()
export class SearchService {
  @Cached({
    key: (query: string, page: number) => `search:${query}:page:${page}`,
    ttlMs: 60_000,
  })
  async search(query: string, page: number) {
    return this.searchEngine.query(query, { page });
  }
}
```

### Key Design Tips

- Include enough context to be unique: `user:${id}` not just `${id}`.
- Use consistent separators (`:` is conventional for cache keys).
- For complex arguments, consider hashing: `results:${hash(JSON.stringify(filters))}`.

## Manual Injection

If you need direct access to the `CacheManager` instead of using the decorator, inject it with the `CACHE_MANAGER` token:

```ts
import { Injectable, Inject } from "@nestjs/common";
import { CACHE_MANAGER } from "@ziggurat/nestjs";
import type { CacheManager } from "@ziggurat/core";

@Injectable()
export class AnalyticsService {
  constructor(@Inject(CACHE_MANAGER) private cache: CacheManager) {}

  async getDashboardData(orgId: string) {
    return this.cache.wrap(
      `dashboard:${orgId}`,
      async () => {
        const [users, revenue, activity] = await Promise.all([
          this.getUsers(orgId),
          this.getRevenue(orgId),
          this.getActivity(orgId),
        ]);
        return { users, revenue, activity };
      },
      120_000, // 2 minutes
    );
  }
}
```

## Cache Invalidation

To invalidate cached data (e.g., after a mutation), inject the `CacheManager` and call `delete`:

```ts
@Injectable()
export class UserService {
  constructor(@Inject(CACHE_MANAGER) private cache: CacheManager) {}

  @Cached({
    key: (id: string) => `user:profile:${id}`,
    ttlMs: 300_000,
  })
  async getUserProfile(id: string) {
    return this.db.users.findById(id);
  }

  async updateUserProfile(id: string, data: UpdateUserDto) {
    await this.db.users.update(id, data);
    // Invalidate the cached profile
    await this.cache.delete(`user:profile:${id}`);
  }
}
```

## Testing

In tests, you can provide a mock or real `CacheManager` using NestJS testing utilities:

```ts
import { Test } from "@nestjs/testing";
import { CACHE_MANAGER } from "@ziggurat/nestjs";
import { CacheManager, MemoryAdapter } from "@ziggurat/core";

const module = await Test.createTestingModule({
  providers: [
    UserService,
    {
      provide: CACHE_MANAGER,
      useValue: new CacheManager({
        layers: [new MemoryAdapter()],
      }),
    },
  ],
}).compile();

const service = module.get(UserService);
```
