/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-extraneous-class, @typescript-eslint/no-unsafe-argument */
import { Module, type DynamicModule } from "@nestjs/common";
import { CacheManager, type CacheManagerOptions } from "@ziggurat/core";
import { CACHE_MANAGER } from "./constants.js";

export interface ZigguratModuleAsyncOptions {
  imports?: any[];
  useFactory: (
    ...args: any[]
  ) => CacheManagerOptions | Promise<CacheManagerOptions>;
  inject?: any[];
}

@Module({})
export class ZigguratModule {
  static forRoot(options: CacheManagerOptions): DynamicModule {
    return {
      module: ZigguratModule,
      global: true,
      providers: [
        {
          provide: CACHE_MANAGER,
          useValue: new CacheManager(options),
        },
      ],
      exports: [CACHE_MANAGER],
    };
  }

  static forRootAsync(options: ZigguratModuleAsyncOptions): DynamicModule {
    return {
      module: ZigguratModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        {
          provide: CACHE_MANAGER,
          useFactory: async (...args: any[]) => {
            const config = await options.useFactory(...args);
            return new CacheManager(config);
          },
          inject: options.inject ?? [],
        },
      ],
      exports: [CACHE_MANAGER],
    };
  }
}
