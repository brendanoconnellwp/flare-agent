// Vertical configs are bundled at build time (static imports — Workers has no
// runtime filesystem) and Zod-validated once per isolate. `pnpm deploy` also
// runs scripts/validate-config.ts so a bad config fails the deploy, not a
// production request.

import { VerticalConfig } from "./schema";
import plumbing from "../../verticals/plumbing.json";
import electrical from "../../verticals/electrical.json";

const RAW_VERTICALS: Record<string, unknown> = { plumbing, electrical };

const validated = new Map<string, VerticalConfig>();

export function loadConfig(vertical: string): VerticalConfig {
  const cached = validated.get(vertical);
  if (cached) return cached;

  const raw = RAW_VERTICALS[vertical];
  if (!raw) {
    throw new Error(
      `Unknown VERTICAL "${vertical}". Available: ${Object.keys(RAW_VERTICALS).join(", ")}. ` +
        `Add verticals/${vertical}.json and register it in src/config/load.ts.`
    );
  }

  const config = VerticalConfig.parse(raw);
  validated.set(vertical, config);
  return config;
}
