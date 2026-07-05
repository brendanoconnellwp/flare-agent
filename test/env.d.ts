// Types the `env` seen by tests: the worker's Env (from wrangler types)
// plus the TEST_MIGRATIONS binding defined in vitest.config.ts.

import type { D1Migration } from "cloudflare:test";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
