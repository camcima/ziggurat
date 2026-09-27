import { describe, it, expect } from "vitest";
import { decodeCacheEntry } from "../../src/index.js";

describe("decodeCacheEntry", () => {
  it("decodes a permanent entry", () => {
    expect(decodeCacheEntry('{"value":"v","expiresAt":null}')).toEqual({
      value: "v",
      expiresAt: null,
    });
  });

  it("decodes an entry with a finite expiry", () => {
    expect(
      decodeCacheEntry('{"value":{"a":1},"expiresAt":1700000000000}'),
    ).toEqual({
      value: { a: 1 },
      expiresAt: 1700000000000,
    });
  });

  it("decodes a stored null value as a hit", () => {
    expect(decodeCacheEntry('{"value":null,"expiresAt":null}')).toEqual({
      value: null,
      expiresAt: null,
    });
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["JSON null", "null"],
    ["an array", "[1,2]"],
    ["a number", "42"],
    ["a string", '"text"'],
    ["an empty object", "{}"],
    ["a missing value", '{"expiresAt":null}'],
    ["a missing expiresAt", '{"value":1}'],
    ["a string expiresAt", '{"value":1,"expiresAt":"soon"}'],
    ["a non-finite expiresAt", '{"value":1,"expiresAt":1e400}'],
  ])("returns null for %s", (_label, raw) => {
    expect(decodeCacheEntry(raw)).toBeNull();
  });
});
