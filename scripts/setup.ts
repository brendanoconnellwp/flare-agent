// One-command setup so the public path is the production path (CLAUDE.md):
//
//   pnpm run setup            → local dev setup: validate configs, apply D1
//                               schema to the local database, scaffold .dev.vars
//   pnpm run setup --remote   → additionally: create the remote D1 database if
//                               missing, patch its id into wrangler.jsonc, apply
//                               the schema remotely, and prompt for secrets
//
// ("pnpm run" is required: bare `pnpm setup` hits pnpm's builtin setup command.)
//
// Requires wrangler auth (`wrangler login`) for --remote.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";

const root = join(import.meta.dirname, "..");
const DB_NAME = "missed-call-agent";
const remote = process.argv.includes("--remote");

function run(args: string[], opts: { capture?: boolean } = {}): string {
  console.log(`$ ${args.join(" ")}`);
  return execFileSync(args[0]!, args.slice(1), {
    cwd: root,
    shell: process.platform === "win32", // .cmd shims on Windows
    stdio: opts.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
  }) as string;
}

// 1. Configs must be valid before anything touches a database.
run(["pnpm", "validate:config"]);

// 2. Local D1: wrangler dev keeps this in .wrangler/state, no account needed.
run(["pnpm", "wrangler", "d1", "execute", DB_NAME, "--local", "--file", "db/schema.sql"]);

// 3. .dev.vars for local secrets.
if (!existsSync(join(root, ".dev.vars"))) {
  copyFileSync(join(root, ".dev.vars.example"), join(root, ".dev.vars"));
  console.log("Created .dev.vars from .dev.vars.example — fill in real values when you wire up Twilio.");
}

if (!remote) {
  console.log("\nLocal setup done. Run `pnpm dev` then `pnpm chat`. For cloud setup: pnpm run setup --remote");
  process.exit(0);
}

// 4. Remote D1: create if missing, patch the id into wrangler.jsonc.
const listJson = run(["pnpm", "wrangler", "d1", "list", "--json"], { capture: true });
const existing = (JSON.parse(listJson) as { name: string; uuid: string }[]).find((d) => d.name === DB_NAME);

let dbId: string;
if (existing) {
  dbId = existing.uuid;
  console.log(`D1 database "${DB_NAME}" already exists (${dbId}).`);
} else {
  run(["pnpm", "wrangler", "d1", "create", DB_NAME]);
  const created = (JSON.parse(run(["pnpm", "wrangler", "d1", "list", "--json"], { capture: true })) as {
    name: string;
    uuid: string;
  }[]).find((d) => d.name === DB_NAME);
  if (!created) throw new Error(`Created "${DB_NAME}" but cannot find it in d1 list output.`);
  dbId = created.uuid;
}

const configPath = join(root, "wrangler.jsonc");
const config = readFileSync(configPath, "utf8");
const patched = config.replace(/"database_id":\s*"[^"]*"/, `"database_id": "${dbId}"`);
if (patched !== config) {
  writeFileSync(configPath, patched);
  console.log(`Patched wrangler.jsonc with database_id ${dbId}.`);
}

run(["pnpm", "wrangler", "d1", "execute", DB_NAME, "--remote", "--file", "db/schema.sql"]);

// 5. Secrets. Skipped when stdin isn't a TTY (CI); run again interactively.
const SECRETS = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_NUMBER"];
if (process.stdin.isTTY) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (const name of SECRETS) {
    const value = (await rl.question(`${name} (blank to skip): `)).trim();
    if (!value) continue;
    execFileSync("pnpm", ["wrangler", "secret", "put", name], {
      cwd: root,
      shell: process.platform === "win32",
      input: value,
      stdio: ["pipe", "inherit", "inherit"],
    });
  }
  rl.close();
} else {
  console.log(`Non-interactive shell: skipping secret prompts (${SECRETS.join(", ")}). Set them with \`wrangler secret put\`.`);
}

console.log("\nRemote setup done. Deploy with `pnpm run deploy`.");
