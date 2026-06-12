import type {
  AdapterTtlOptions,
  CacheEntry,
  CacheSetEntry,
  TtlResult,
} from "@ziggurat-cache/core";
import { BaseCacheAdapter } from "@ziggurat-cache/core";
import type Database from "better-sqlite3";

// Max keys per IN(...) chunk. SQLite caps bound params at 999 (older
// builds) / 32766 (modern). mget binds batch.length + 2 (namespace, now);
// mdel binds batch.length + 1 (namespace). 900 stays safe under 999.
const MAX_BATCH_PARAMS = 900;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export interface SQLiteAdapterOptions extends AdapterTtlOptions {
  db: Database.Database;
  tableName?: string;
  namespace?: string;
}

export class SQLiteAdapter extends BaseCacheAdapter {
  readonly name = "sqlite";
  private readonly db: Database.Database;
  private readonly tableName: string;
  private readonly namespace: string;

  private readonly stmtGet: Database.Statement;
  private readonly stmtSet: Database.Statement;
  private readonly stmtDel: Database.Statement;
  private readonly stmtClear: Database.Statement;
  private readonly stmtHas: Database.Statement;
  private readonly stmtGetTtl: Database.Statement;
  private readonly stmtKeys: Database.Statement;
  private readonly stmtFlushAll: Database.Statement;
  private readonly stmtPurge: Database.Statement;

  private static validateTableName(name: string): void {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(
        `Invalid table name "${name}": must contain only alphanumeric characters and underscores, and start with a letter or underscore.`,
      );
    }
  }

  constructor(options: SQLiteAdapterOptions) {
    super(options);
    this.db = options.db;
    this.tableName = options.tableName ?? "ziggurat_cache";
    SQLiteAdapter.validateTableName(this.tableName);
    this.namespace = options.namespace ?? "";

    // Enable WAL mode for better concurrent read performance
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    // Create table and index if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER,
        PRIMARY KEY (namespace, key)
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_expires
      ON ${this.tableName} (expires_at)
      WHERE expires_at IS NOT NULL
    `);

    // Prepare statements
    this.stmtGet = this.db.prepare(
      `SELECT value, expires_at FROM ${this.tableName} WHERE namespace = ? AND key = ?`,
    );
    this.stmtSet = this.db.prepare(
      `INSERT OR REPLACE INTO ${this.tableName} (namespace, key, value, expires_at) VALUES (?, ?, ?, ?)`,
    );
    this.stmtDel = this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE namespace = ? AND key = ?`,
    );
    this.stmtClear = this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE namespace = ?`,
    );
    this.stmtHas = this.db.prepare(
      `SELECT 1 FROM ${this.tableName} WHERE namespace = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)`,
    );
    this.stmtGetTtl = this.db.prepare(
      `SELECT expires_at FROM ${this.tableName} WHERE namespace = ? AND key = ?`,
    );
    this.stmtKeys = this.db.prepare(
      `SELECT key FROM ${this.tableName} WHERE namespace = ? AND (expires_at IS NULL OR expires_at > ?)`,
    );
    this.stmtFlushAll = this.db.prepare(`DELETE FROM ${this.tableName}`);
    this.stmtPurge = this.db.prepare(
      `DELETE FROM ${this.tableName} WHERE namespace = ? AND expires_at IS NOT NULL AND expires_at <= ?`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async get<T>(key: string): Promise<CacheEntry<T> | null> {
    const row = this.stmtGet.get(this.namespace, key) as
      | { value: string; expires_at: number | null }
      | undefined;
    if (!row) return null;

    if (row.expires_at !== null && Date.now() >= row.expires_at) {
      this.stmtDel.run(this.namespace, key);
      return null;
    }

    let parsed: T;
    try {
      parsed = JSON.parse(row.value) as T;
    } catch {
      // Corrupt/legacy payload — delete and treat as a miss (consistent with Redis/Memcache).
      this.stmtDel.run(this.namespace, key);
      return null;
    }
    return { value: parsed, expiresAt: row.expires_at };
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/require-await
  async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const effectiveTtl = this.resolveTtl(ttlMs);
    // ttlMs <= 0 means already expired — don't store
    if (effectiveTtl !== undefined && effectiveTtl <= 0) return;
    const expiresAt =
      effectiveTtl !== undefined ? Date.now() + effectiveTtl : null;
    const serialized = JSON.stringify(value);
    this.stmtSet.run(this.namespace, key, serialized, expiresAt);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async delete(key: string): Promise<void> {
    this.stmtDel.run(this.namespace, key);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async clear(): Promise<void> {
    this.stmtClear.run(this.namespace);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async has(key: string): Promise<boolean> {
    const row = this.stmtHas.get(this.namespace, key, Date.now());
    return row !== undefined;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getTtl(key: string): Promise<TtlResult> {
    const row = this.stmtGetTtl.get(this.namespace, key) as
      | { expires_at: number | null }
      | undefined;
    if (!row) return { kind: "missing" };

    if (row.expires_at === null) return { kind: "permanent" };

    const remaining = row.expires_at - Date.now();
    if (remaining <= 0) {
      // Clean up expired entry
      this.stmtDel.run(this.namespace, key);
      return { kind: "missing" };
    }

    return { kind: "expiring", ttlMs: remaining };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async keys(): Promise<string[]> {
    const rows = this.stmtKeys.all(this.namespace, Date.now()) as Array<{
      key: string;
    }>;
    return rows.map((r) => r.key);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async mget<T>(keys: readonly string[]): Promise<Map<string, CacheEntry<T>>> {
    if (keys.length === 0) return new Map();

    const now = Date.now();
    const result = new Map<string, CacheEntry<T>>();
    const corruptKeys: string[] = [];
    for (const batch of chunk(keys, MAX_BATCH_PARAMS)) {
      const placeholders = batch.map(() => "?").join(",");
      const stmt = this.db.prepare(
        `SELECT key, value, expires_at FROM ${this.tableName}
         WHERE namespace = ? AND key IN (${placeholders})
         AND (expires_at IS NULL OR expires_at > ?)`,
      );
      const rows = stmt.all(this.namespace, ...batch, now) as Array<{
        key: string;
        value: string;
        expires_at: number | null;
      }>;
      for (const row of rows) {
        let parsed: T;
        try {
          parsed = JSON.parse(row.value) as T;
        } catch {
          corruptKeys.push(row.key);
          continue;
        }
        result.set(row.key, { value: parsed, expiresAt: row.expires_at });
      }
    }
    if (corruptKeys.length > 0) {
      const deleteCorrupt = this.db.transaction((batches: string[][]) => {
        for (const batch of batches) {
          const placeholders = batch.map(() => "?").join(",");
          const stmt = this.db.prepare(
            `DELETE FROM ${this.tableName} WHERE namespace = ? AND key IN (${placeholders})`,
          );
          stmt.run(this.namespace, ...batch);
        }
      });
      deleteCorrupt(chunk(corruptKeys, MAX_BATCH_PARAMS));
    }
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async mset<T>(entries: readonly CacheSetEntry<T>[]): Promise<void> {
    if (entries.length === 0) return;

    const insertMany = this.db.transaction(
      (items: readonly CacheSetEntry<T>[]) => {
        for (const entry of items) {
          const effectiveTtl = this.resolveTtl(entry.ttlMs);
          // ttlMs <= 0 means already expired — don't store
          if (effectiveTtl !== undefined && effectiveTtl <= 0) continue;
          const expiresAt =
            effectiveTtl !== undefined ? Date.now() + effectiveTtl : null;
          const serialized = JSON.stringify(entry.value);
          this.stmtSet.run(this.namespace, entry.key, serialized, expiresAt);
        }
      },
    );
    insertMany(entries);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async mdel(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;

    const deleteMany = this.db.transaction((batches: string[][]) => {
      for (const batch of batches) {
        const placeholders = batch.map(() => "?").join(",");
        const stmt = this.db.prepare(
          `DELETE FROM ${this.tableName} WHERE namespace = ? AND key IN (${placeholders})`,
        );
        stmt.run(this.namespace, ...batch);
      }
    });
    deleteMany(chunk(keys, MAX_BATCH_PARAMS));
  }

  /**
   * Delete ALL rows in the cache table across EVERY namespace. Unlike
   * clear() (which is scoped to this adapter's namespace), flushAll()
   * wipes the whole table — use clear() for a per-namespace reset.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async flushAll(): Promise<void> {
    this.stmtFlushAll.run();
  }

  /**
   * Delete all expired rows for this adapter's namespace and return the
   * number of rows removed. Expired rows are otherwise only cleaned up
   * lazily on access — call this periodically in long-running processes.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async purgeExpired(): Promise<number> {
    const result = this.stmtPurge.run(this.namespace, Date.now());
    return result.changes;
  }
}
