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

export interface CacheManagerOptions {
  layers: CacheAdapter[];
  namespace?: string;
  syncBackfill?: boolean;
  stampede?: StampedeConfig;
}

export interface MemoryAdapterOptions {
  defaultTtlMs?: number;
}
