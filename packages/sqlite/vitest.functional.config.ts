import { defineConfig } from "vitest/config";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load .env from repo root if present (supports "cp .env.example .env" workflow)
const rootEnv = resolve(dirname(fileURLToPath(import.meta.url)), "../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq);
    if (!process.env[key]) process.env[key] = t.slice(eq + 1);
  }
}

export default defineConfig({
  test: {
    globals: true,
    include: ["tests/functional/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
