import { describe, it, expect, vi } from "vitest";
import { TypedEventEmitter } from "../../src/event-emitter.js";

type TestEvents = {
  ping: { message: string };
  pong: { count: number };
};

describe("TypedEventEmitter", () => {
  it("should call listener when event is emitted", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const listener = vi.fn();
    emitter.on("ping", listener);

    emitter.emit("ping", { message: "hello" });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ message: "hello" });
  });

  it("should support multiple listeners on the same event", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    emitter.on("ping", listener1);
    emitter.on("ping", listener2);

    emitter.emit("ping", { message: "hello" });

    expect(listener1).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it("should not call listeners for different events", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const pingListener = vi.fn();
    const pongListener = vi.fn();
    emitter.on("ping", pingListener);
    emitter.on("pong", pongListener);

    emitter.emit("ping", { message: "hello" });

    expect(pingListener).toHaveBeenCalledOnce();
    expect(pongListener).not.toHaveBeenCalled();
  });

  it("should return an unsubscribe function", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const listener = vi.fn();
    const unsub = emitter.on("ping", listener);

    emitter.emit("ping", { message: "first" });
    unsub();
    emitter.emit("ping", { message: "second" });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ message: "first" });
  });

  it("should not throw when emitting with no listeners", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    expect(() => emitter.emit("ping", { message: "hello" })).not.toThrow();
  });

  it("should report hasListeners correctly", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    expect(emitter.hasListeners("ping")).toBe(false);

    const unsub = emitter.on("ping", vi.fn());
    expect(emitter.hasListeners("ping")).toBe(true);
    expect(emitter.hasListeners("pong")).toBe(false);

    unsub();
    expect(emitter.hasListeners("ping")).toBe(false);
  });

  it("should not break when a listener throws", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const listener1 = vi.fn();
    const throwingListener = vi.fn(() => {
      throw new Error("listener error");
    });
    const listener2 = vi.fn();
    emitter.on("ping", listener1);
    emitter.on("ping", throwingListener);
    emitter.on("ping", listener2);

    expect(() => emitter.emit("ping", { message: "hello" })).not.toThrow();

    expect(listener1).toHaveBeenCalledOnce();
    expect(throwingListener).toHaveBeenCalledOnce();
    expect(listener2).toHaveBeenCalledOnce();
  });

  it("should remove all listeners", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    emitter.on("ping", listener1);
    emitter.on("pong", listener2);

    emitter.removeAllListeners();

    emitter.emit("ping", { message: "hello" });
    emitter.emit("pong", { count: 1 });

    expect(listener1).not.toHaveBeenCalled();
    expect(listener2).not.toHaveBeenCalled();
    expect(emitter.hasListeners("ping")).toBe(false);
    expect(emitter.hasListeners("pong")).toBe(false);
  });
});
