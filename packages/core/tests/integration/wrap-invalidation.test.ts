import { describe, it, expect, vi } from "vitest";
import { CacheManager } from "../../src/cache-manager.js";
import { MemoryAdapter } from "../../src/memory-adapter.js";

/**
 * A factory that signals when it starts and resolves only when released,
 * so a mutation can be completed while the wrap() is provably in flight.
 */
function gatedFactory<T>(value: T) {
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const factory = vi.fn(async () => {
    markStarted();
    await gate;
    return value;
  });
  return { factory, started, release };
}

describe("Mutations fence in-flight wrap() calls", () => {
  it("does not restore a key deleted while its factory was running", async () => {
    const manager = new CacheManager({ layers: [new MemoryAdapter()] });
    const { factory, started, release } = gatedFactory("old");

    const pending = manager.wrap("key1", factory);
    await started;
    await manager.delete("key1");
    release();

    // The caller that asked before the delete still gets its value...
    await expect(pending).resolves.toBe("old");
    // ...but it is not written back over the delete.
    expect(await manager.get("key1")).toBeNull();
  });

  it("does not overwrite a value set while its factory was running", async () => {
    const manager = new CacheManager({ layers: [new MemoryAdapter()] });
    const { factory, started, release } = gatedFactory("old");

    const pending = manager.wrap("key1", factory);
    await started;
    await manager.set("key1", "new");
    release();
    await pending;

    expect((await manager.get("key1"))?.value).toBe("new");
  });

  it("does not restore a key removed by mdel while its factory was running", async () => {
    const manager = new CacheManager({ layers: [new MemoryAdapter()] });
    const { factory, started, release } = gatedFactory("old");

    const pending = manager.wrap("key1", factory);
    await started;
    await manager.mdel(["other", "key1"]);
    release();
    await pending;

    expect(await manager.get("key1")).toBeNull();
  });

  it("does not overwrite a value written by mset while its factory was running", async () => {
    const manager = new CacheManager({ layers: [new MemoryAdapter()] });
    const { factory, started, release } = gatedFactory("old");

    const pending = manager.wrap("key1", factory);
    await started;
    await manager.mset([{ key: "key1", value: "new" }]);
    release();
    await pending;

    expect((await manager.get("key1"))?.value).toBe("new");
  });

  it("does not hand an invalidated in-flight wrap to later callers", async () => {
    const manager = new CacheManager({ layers: [new MemoryAdapter()] });
    const { factory, started, release } = gatedFactory("old");

    const stale = manager.wrap("key1", factory);
    await started;
    await manager.delete("key1");

    const freshFactory = vi.fn(async () => "fresh");
    await expect(manager.wrap("key1", freshFactory)).resolves.toBe("fresh");
    expect(freshFactory).toHaveBeenCalledOnce();

    release();
    await expect(stale).resolves.toBe("old");
    expect((await manager.get("key1"))?.value).toBe("fresh");
  });

  it("fences in-flight wraps when coalescing is disabled", async () => {
    const manager = new CacheManager({
      layers: [new MemoryAdapter()],
      stampede: { coalesce: false },
    });
    const { factory, started, release } = gatedFactory("old");

    const pending = manager.wrap("key1", factory);
    await started;
    await manager.delete("key1");
    release();
    await pending;

    expect(await manager.get("key1")).toBeNull();
  });

  it("leaves wraps for other keys untouched", async () => {
    const manager = new CacheManager({ layers: [new MemoryAdapter()] });
    const { factory, started, release } = gatedFactory("value");

    const pending = manager.wrap("key1", factory);
    await started;
    await manager.delete("key2");
    release();
    await pending;

    expect((await manager.get("key1"))?.value).toBe("value");
  });

  it("applies the fence to namespaced managers", async () => {
    const manager = new CacheManager({
      layers: [new MemoryAdapter()],
      namespace: "ns",
    });
    const { factory, started, release } = gatedFactory("old");

    const pending = manager.wrap("key1", factory);
    await started;
    await manager.delete("key1");
    release();
    await pending;

    expect(await manager.get("key1")).toBeNull();
  });
});
