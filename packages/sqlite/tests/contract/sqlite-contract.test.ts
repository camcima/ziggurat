import { runAdapterContractTests } from "../../../core/tests/contract/adapter-contract.test.js";
import { SQLiteAdapter } from "../../src/sqlite-adapter.js";
import Database from "better-sqlite3";

runAdapterContractTests(
  "SQLiteAdapter",
  () => new SQLiteAdapter({ db: new Database(":memory:") }),
);
