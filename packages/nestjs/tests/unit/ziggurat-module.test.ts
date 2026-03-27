import "reflect-metadata";
import { describe, it, expect } from "vitest";
import { Test } from "@nestjs/testing";
import { Injectable, Module } from "@nestjs/common";
import { ZigguratModule } from "../../src/ziggurat.module.js";
import { CACHE_MANAGER } from "../../src/constants.js";
import { CacheManager, MemoryAdapter } from "@ziggurat-cache/core";

describe("ZigguratModule", () => {
  describe("forRoot", () => {
    it("should provide CacheManager via CACHE_MANAGER token", async () => {
      const module = await Test.createTestingModule({
        imports: [
          ZigguratModule.forRoot({
            layers: [new MemoryAdapter()],
          }),
        ],
      }).compile();

      const cacheManager = module.get(CACHE_MANAGER);
      expect(cacheManager).toBeInstanceOf(CacheManager);
    });

    it("should provide a functional CacheManager", async () => {
      const module = await Test.createTestingModule({
        imports: [
          ZigguratModule.forRoot({
            layers: [new MemoryAdapter()],
          }),
        ],
      }).compile();

      const cacheManager = module.get<CacheManager>(CACHE_MANAGER);
      await cacheManager.set("test", "value");
      const result = await cacheManager.get<string>("test");
      expect(result!.value).toBe("value");
    });
  });

  describe("forRootAsync", () => {
    it("should provide CacheManager via async factory", async () => {
      const module = await Test.createTestingModule({
        imports: [
          ZigguratModule.forRootAsync({
            useFactory: () => ({
              layers: [new MemoryAdapter()],
            }),
          }),
        ],
      }).compile();

      const cacheManager = module.get(CACHE_MANAGER);
      expect(cacheManager).toBeInstanceOf(CacheManager);
    });

    it("should support factory injection", async () => {
      const CONFIG_TOKEN = "CONFIG_VALUE";

      @Module({
        providers: [{ provide: CONFIG_TOKEN, useValue: 500 }],
        exports: [CONFIG_TOKEN],
      })
      class ConfigModule {}

      const module = await Test.createTestingModule({
        imports: [
          ZigguratModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: (defaultTtlMs: number) => ({
              layers: [new MemoryAdapter({ defaultTtlMs })],
            }),
            inject: [CONFIG_TOKEN],
          }),
        ],
      }).compile();

      const cacheManager = module.get(CACHE_MANAGER);
      expect(cacheManager).toBeInstanceOf(CacheManager);
    });
  });

  describe("CacheManager injectable in services", () => {
    it("should be injectable into a service via @Inject(CACHE_MANAGER)", async () => {
      @Injectable()
      class TestService {
        constructor(
          @((await import("@nestjs/common")).Inject(CACHE_MANAGER))
          public readonly cache: CacheManager,
        ) {}
      }

      const module = await Test.createTestingModule({
        imports: [
          ZigguratModule.forRoot({
            layers: [new MemoryAdapter()],
          }),
        ],
        providers: [TestService],
      }).compile();

      const service = module.get(TestService);
      expect(service.cache).toBeInstanceOf(CacheManager);
    });
  });
});
