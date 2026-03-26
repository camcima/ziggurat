import { describe, it, expect, vi } from "vitest";
import { CacheManager } from "../../src/cache-manager.js";
import { MemoryAdapter } from "../../src/memory-adapter.js";

describe("Stampede Protection (Request Coalescing)", () => {
  describe("with coalescing enabled (default)", () => {
    it("should call factory exactly once for 100 concurrent wrap calls", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const factory = vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((resolve) => setTimeout(() => resolve("value"), 50)),
        );

      const promises = Array.from({ length: 100 }, () =>
        manager.wrap("key1", factory),
      );

      const results = await Promise.all(promises);

      expect(factory).toHaveBeenCalledOnce();
      for (const result of results) {
        expect(result).toBe("value");
      }
    });

    it("should call factory exactly once for concurrent calls with different timing", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      let callCount = 0;
      const factory = vi.fn().mockImplementation(async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return `result-${callCount}`;
      });

      const p1 = manager.wrap("key1", factory);
      const p2 = manager.wrap("key1", factory);
      const p3 = manager.wrap("key1", factory);

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      expect(factory).toHaveBeenCalledOnce();
      expect(r1).toBe("result-1");
      expect(r2).toBe("result-1");
      expect(r3).toBe("result-1");
    });

    it("should allow new factory calls after the first completes", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      let callCount = 0;
      const factory = vi.fn().mockImplementation(async () => {
        callCount++;
        return `result-${callCount}`;
      });

      const r1 = await manager.wrap("key1", factory);
      // Clear cache to force another factory call
      await adapter.clear();
      const r2 = await manager.wrap("key1", factory);

      expect(factory).toHaveBeenCalledTimes(2);
      expect(r1).toBe("result-1");
      expect(r2).toBe("result-2");
    });
  });

  describe("error propagation", () => {
    it("should propagate factory errors to all concurrent callers", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });
      const factory = vi
        .fn()
        .mockImplementation(
          () =>
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("boom")), 50),
            ),
        );

      const promises = Array.from({ length: 10 }, () =>
        manager.wrap("key1", factory),
      );

      const results = await Promise.allSettled(promises);

      expect(factory).toHaveBeenCalledOnce();
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(Error);
          expect((result.reason as Error).message).toBe("boom");
        }
      }
    });

    it("should clean up in-flight entry after error", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({ layers: [adapter] });

      const failingFactory = vi.fn().mockRejectedValue(new Error("fail"));
      const succeedingFactory = vi
        .fn()
        .mockImplementation(async () => "success");

      await expect(manager.wrap("key1", failingFactory)).rejects.toThrow(
        "fail",
      );

      // After error, a new factory call should be allowed
      const result = await manager.wrap("key1", succeedingFactory);
      expect(result).toBe("success");
      expect(succeedingFactory).toHaveBeenCalledOnce();
    });
  });

  describe("with coalescing disabled", () => {
    it("should call factory for each concurrent wrap call", async () => {
      const adapter = new MemoryAdapter();
      const manager = new CacheManager({
        layers: [adapter],
        stampede: { coalesce: false },
      });
      let callCount = 0;
      const factory = vi.fn().mockImplementation(async () => {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return `result-${callCount}`;
      });

      const promises = Array.from({ length: 5 }, () =>
        manager.wrap("key1", factory),
      );

      await Promise.all(promises);

      expect(factory).toHaveBeenCalledTimes(5);
    });
  });
});
