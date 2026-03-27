/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { Inject } from "@nestjs/common";
import type { CacheManager } from "@ziggurat-cache/core";
import { CACHE_MANAGER } from "./constants.js";

export interface CachedDecoratorOptions {
  key: (...args: any[]) => string;
  ttlMs?: number;
}

export function Cached(options: CachedDecoratorOptions): MethodDecorator {
  const injectCacheManager = Inject(CACHE_MANAGER);

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const originalMethod = descriptor.value as (...args: any[]) => Promise<any>;
    const cacheManagerKey = `__ziggurat_cache_manager__`;

    injectCacheManager(target, cacheManagerKey);

    descriptor.value = async function (this: any, ...args: any[]) {
      const cacheManager: CacheManager = this[cacheManagerKey];
      const cacheKey = options.key(...args);

      return cacheManager.wrap(
        cacheKey,
        () => originalMethod.apply(this, args),
        options.ttlMs,
      );
    };

    return descriptor;
  };
}
