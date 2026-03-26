import "reflect-metadata";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Test } from "@nestjs/testing";
import { Injectable } from "@nestjs/common";
import { ZigguratModule } from "../../src/ziggurat.module.js";
import { Cached } from "../../src/cached.decorator.js";
import { CACHE_MANAGER } from "../../src/constants.js";
import { CacheManager, MemoryAdapter } from "@ziggurat/core";

describe("@Cached() decorator", () => {
  let cacheManager: CacheManager;

  @Injectable()
  class TestService {
    callCount = 0;

    @Cached({
      key: (id: string) => `test:${id}`,
      ttlMs: 60000,
    })
    async getData(id: string): Promise<string> {
      this.callCount++;
      return `data-for-${id}`;
    }

    @Cached({
      key: (a: number, b: number) => `sum:${a}:${b}`,
    })
    async getSum(a: number, b: number): Promise<number> {
      this.callCount++;
      return a + b;
    }
  }

  let service: TestService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ZigguratModule.forRoot({
          layers: [new MemoryAdapter()],
        }),
      ],
      providers: [TestService],
    }).compile();

    service = module.get(TestService);
    cacheManager = module.get(CACHE_MANAGER);
  });

  it("should cache the result of a method call", async () => {
    const result1 = await service.getData("123");
    const result2 = await service.getData("123");

    expect(result1).toBe("data-for-123");
    expect(result2).toBe("data-for-123");
    expect(service.callCount).toBe(1);
  });

  it("should invoke the method on cache miss", async () => {
    const result = await service.getData("456");
    expect(result).toBe("data-for-456");
    expect(service.callCount).toBe(1);
  });

  it("should use the key function with method arguments", async () => {
    await service.getData("abc");
    const cached = await cacheManager.get<string>("test:abc");
    expect(cached).not.toBeNull();
    expect(cached!.value).toBe("data-for-abc");
  });

  it("should apply TTL when specified", async () => {
    await service.getData("ttl-test");
    const cached = await cacheManager.get<string>("test:ttl-test");
    expect(cached!.expiresAt).toBeTypeOf("number");
  });

  it("should handle multiple arguments in key function", async () => {
    const result = await service.getSum(3, 4);
    expect(result).toBe(7);

    const cached = await cacheManager.get<number>("sum:3:4");
    expect(cached!.value).toBe(7);
  });

  it("should use different cache keys for different arguments", async () => {
    await service.getData("x");
    await service.getData("y");

    expect(service.callCount).toBe(2);

    const cachedX = await cacheManager.get<string>("test:x");
    const cachedY = await cacheManager.get<string>("test:y");
    expect(cachedX!.value).toBe("data-for-x");
    expect(cachedY!.value).toBe("data-for-y");
  });
});
