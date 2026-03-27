export interface CacheEntry<T> {
  value: T;
  expiresAt: number | null;
}

export interface CacheSetEntry<T> {
  key: string;
  value: T;
  ttlMs?: number;
}

export type TtlResult =
  | { kind: "missing" }
  | { kind: "permanent" }
  | { kind: "expiring"; ttlMs: number };

export interface CacheAdapter {
  readonly name: string;
  get<T>(key: string): Promise<CacheEntry<T> | null>;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  has(key: string): Promise<boolean>;
  getTtl(key: string): Promise<TtlResult>;
  keys(): Promise<string[]>;
  mget<T>(keys: readonly string[]): Promise<Map<string, CacheEntry<T>>>;
  mset<T>(entries: readonly CacheSetEntry<T>[]): Promise<void>;
  mdel(keys: readonly string[]): Promise<void>;
  flushAll(): Promise<void>;
}

export interface StampedeConfig {
  coalesce?: boolean;
}

// ── Cache Events ──

export interface CacheHitEvent {
  key: string;
  namespace?: string;
  layerName: string;
  layerIndex: number;
  durationMs: number;
}

export interface CacheMissEvent {
  key: string;
  namespace?: string;
  durationMs: number;
}

export interface CacheSetEvent {
  key: string;
  namespace?: string;
  ttlMs?: number;
  durationMs: number;
}

export interface CacheDeleteEvent {
  key: string;
  namespace?: string;
  durationMs: number;
}

export interface CacheErrorEvent {
  key: string;
  namespace?: string;
  operation:
    | "get"
    | "set"
    | "delete"
    | "has"
    | "getTtl"
    | "mget"
    | "mset"
    | "mdel";
  layerName: string;
  layerIndex: number;
  error: unknown;
}

export interface CacheBackfillEvent {
  key: string;
  namespace?: string;
  sourceLayerName: string;
  sourceLayerIndex: number;
  targetLayerNames: string[];
}

export interface CacheWrapHitEvent {
  key: string;
  namespace?: string;
  durationMs: number;
}

export interface CacheWrapMissEvent {
  key: string;
  namespace?: string;
  durationMs: number;
  factoryDurationMs: number;
}

export interface CacheWrapCoalesceEvent {
  key: string;
  namespace?: string;
}

export interface CacheMgetEvent {
  keys: string[];
  namespace?: string;
  hitCount: number;
  missCount: number;
  durationMs: number;
}

export interface CacheMsetEvent {
  keyCount: number;
  namespace?: string;
  durationMs: number;
}

export interface CacheMdelEvent {
  keyCount: number;
  namespace?: string;
  durationMs: number;
}

export type CacheEventMap = {
  hit: CacheHitEvent;
  miss: CacheMissEvent;
  set: CacheSetEvent;
  delete: CacheDeleteEvent;
  error: CacheErrorEvent;
  backfill: CacheBackfillEvent;
  "wrap:hit": CacheWrapHitEvent;
  "wrap:miss": CacheWrapMissEvent;
  "wrap:coalesce": CacheWrapCoalesceEvent;
  mget: CacheMgetEvent;
  mset: CacheMsetEvent;
  mdel: CacheMdelEvent;
};

// ── Options ──

import type { TypedEventEmitter } from "./event-emitter.js";

export interface CacheManagerOptions {
  layers: CacheAdapter[];
  namespace?: string;
  syncBackfill?: boolean;
  stampede?: StampedeConfig;
  events?: TypedEventEmitter<CacheEventMap>;
}

export interface MemoryAdapterOptions {
  defaultTtlMs?: number;
}
