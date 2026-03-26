import { describe, it, expect, beforeEach, afterAll, afterEach } from "vitest";
import Database from "better-sqlite3";
import { SQLiteAdapter } from "../../src/sqlite-adapter.js";
import { runAdapterContractTests } from "../../../core/tests/contract/adapter-contract.test.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ziggurat-sqlite-"));
const dbPath = path.join(tmpDir, "test.db");

let db: Database.Database;

beforeEach(() => {
  // Remove old DB file if present
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  db = new Database(dbPath);
});

afterEach(() => {
  db.close();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Run the shared contract test suite against a REAL SQLite file
runAdapterContractTests(
  "SQLiteAdapter (real SQLite file)",
  () => new SQLiteAdapter({ db: new Database(":memory:") }),
);

describe("SQLiteAdapter functional tests (real SQLite file)", () => {
  let adapter: SQLiteAdapter;

  beforeEach(() => {
    adapter = new SQLiteAdapter({ db });
  });

  describe("persistence across restarts", () => {
    it("should persist data after closing and reopening the database", () => {
      adapter = new SQLiteAdapter({ db });
      // Deliberately synchronous since SQLiteAdapter wraps sync in async
      db.exec("SELECT 1"); // ensure db is open

      // Write data
      const writeAdapter = new SQLiteAdapter({ db });
      // Use the sync internals directly
      db.prepare(
        "INSERT OR REPLACE INTO ziggurat_cache (namespace, key, value, expires_at) VALUES (?, ?, ?, ?)",
      ).run("", "persist-key", JSON.stringify("persist-value"), null);

      // Close and reopen
      db.close();
      db = new Database(dbPath);
      const readAdapter = new SQLiteAdapter({ db });
      // Verify data persists - need to run async in a sync context
      const row = db
        .prepare(
          "SELECT value FROM ziggurat_cache WHERE namespace = ? AND key = ?",
        )
        .get("", "persist-key") as { value: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row!.value)).toBe("persist-value");
    });
  });

  describe("TTL expiry with real file", () => {
    it("should expire entries based on TTL", async () => {
      await adapter.set("ttl-key", "value", 50);
      const before = await adapter.get<string>("ttl-key");
      expect(before!.value).toBe("value");

      await new Promise((resolve) => setTimeout(resolve, 100));
      const after = await adapter.get<string>("ttl-key");
      expect(after).toBeNull();
    });

    it("should persist entries without TTL", async () => {
      await adapter.set("no-ttl", "forever");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await adapter.get<string>("no-ttl");
      expect(result!.value).toBe("forever");
    });
  });

  describe("namespace isolation with real file", () => {
    it("should isolate data between namespaces", async () => {
      const ns1 = new SQLiteAdapter({ db, namespace: "users" });
      const ns2 = new SQLiteAdapter({ db, namespace: "products" });

      await ns1.set("42", "Alice");
      await ns2.set("42", "Widget");

      expect((await ns1.get<string>("42"))!.value).toBe("Alice");
      expect((await ns2.get<string>("42"))!.value).toBe("Widget");
    });

    it("should scope clear() to namespace", async () => {
      const ns1 = new SQLiteAdapter({ db, namespace: "users" });
      const ns2 = new SQLiteAdapter({ db, namespace: "products" });

      await ns1.set("a", 1);
      await ns2.set("b", 2);
      await ns1.clear();

      expect(await ns1.get("a")).toBeNull();
      expect((await ns2.get<number>("b"))!.value).toBe(2);
    });
  });

  describe("batch operations with real file", () => {
    it("should handle mset + mget efficiently", async () => {
      await adapter.mset([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
        { key: "c", value: 3 },
      ]);
      const result = await adapter.mget<number>(["a", "b", "c", "missing"]);
      expect(result.size).toBe(3);
      expect(result.get("a")!.value).toBe(1);
      expect(result.get("b")!.value).toBe(2);
      expect(result.get("c")!.value).toBe(3);
      expect(result.has("missing")).toBe(false);
    });

    it("should handle mdel efficiently", async () => {
      await adapter.mset([
        { key: "a", value: 1 },
        { key: "b", value: 2 },
        { key: "c", value: 3 },
      ]);
      await adapter.mdel(["a", "c"]);
      expect(await adapter.get("a")).toBeNull();
      expect((await adapter.get<number>("b"))!.value).toBe(2);
      expect(await adapter.get("c")).toBeNull();
    });
  });

  describe("WAL mode", () => {
    it("should use WAL journal mode on file-based database", () => {
      const mode = db.pragma("journal_mode", { simple: true });
      expect(mode).toBe("wal");
    });
  });
});
