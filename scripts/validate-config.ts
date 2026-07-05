// Validates every verticals/*.json against the schema. Runs before deploy
// (pnpm deploy) so an invalid config is a failed deploy, not a runtime
// surprise. Node-side twin of src/config/load.ts.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VerticalConfig } from "../src/config/schema";

const dir = join(import.meta.dirname, "..", "verticals");
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

if (files.length === 0) {
  console.error("No vertical configs found in verticals/");
  process.exit(1);
}

let failed = false;
for (const file of files) {
  const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
  const result = VerticalConfig.safeParse(raw);
  if (result.success) {
    console.log(`✓ verticals/${file} (${result.data.business.name}, ${result.data.business.trade})`);
  } else {
    failed = true;
    console.error(`✗ verticals/${file}`);
    for (const issue of result.error.issues) {
      console.error(`    ${issue.path.join(".")}: ${issue.message}`);
    }
  }
}

process.exit(failed ? 1 : 0);
