import { applyD1Migrations, env } from "cloudflare:test";

// Runs before each test file; schema statements are IF NOT EXISTS so this is
// idempotent across vitest's isolated-storage push/pop.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Test-only table backing the MODEL_PROVIDER=mock provider (see
// src/agent/provider.ts): tests seed scripted model responses here.
await env.DB.exec(
  "CREATE TABLE IF NOT EXISTS test_model_script (id INTEGER PRIMARY KEY AUTOINCREMENT, response TEXT NOT NULL);"
);
