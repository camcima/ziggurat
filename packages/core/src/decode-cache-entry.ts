import type { CacheEntry } from "./types.js";

/**
 * Parses a JSON-serialized `{ value, expiresAt }` envelope, as stored by the
 * Redis and Memcache adapters, and checks its shape. Returns `null` — a miss —
 * for invalid JSON or any payload that is not a non-null object with an own
 * `value` property and an `expiresAt` that is `null` or a finite number.
 *
 * Only the envelope is checked. `value` is whatever the payload holds; the
 * caller's `T` is not verified at runtime.
 */
export function decodeCacheEntry<T>(raw: string): CacheEntry<T> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.hasOwn(parsed, "value") ||
    !Object.hasOwn(parsed, "expiresAt")
  ) {
    return null;
  }
  const { value, expiresAt } = parsed as { value: T; expiresAt: unknown };
  if (
    expiresAt !== null &&
    (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
  ) {
    return null;
  }
  return { value, expiresAt };
}
