import path from "node:path";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// Pinned to vitest 3.x + pool-workers 0.12.x deliberately: this architecture
// runs tests, the Worker, and Durable Objects in ONE module graph, so
// vi.mock can replace the model provider inside the DO — the spec requires
// flow tests with the model mocked. The 0.13+/vitest-4 plugin model runs the
// Worker in a separate graph where module mocks cannot reach DO code.

export default defineWorkersConfig(async () => {
  // db/schema.sql is the single "migration"; tests apply it via the
  // TEST_MIGRATIONS binding in test/apply-migrations.ts.
  const migrations = await readD1Migrations(path.resolve("db"));

  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              // Swaps in the D1-scripted test provider — see mockProvider in
              // src/agent/provider.ts.
              MODEL_PROVIDER: "mock",
              ALLOW_SIMULATOR: "true",
              DASHBOARD_TOKEN: "test-dashboard-token",
              // Fast model-timeout so the hang-fallback test runs in ms.
              MODEL_TIMEOUT_MS: "150",
              // Pin the policy clock to midday Pacific (noon PDT) so
              // quiet-hours holds never trigger in flow tests.
              TEST_FIXED_NOW: "2026-07-01T19:00:00Z",
              // A real auth token would come from .dev.vars; tests use a known
              // fake so signature tests are deterministic, and blank the send
              // credentials so no code path can ever hit the real Twilio API.
              TWILIO_AUTH_TOKEN: "test-auth-token-0123456789abcdef",
              TWILIO_ACCOUNT_SID: "",
              TWILIO_NUMBER: "",
            },
          },
        },
      },
    },
  };
});
