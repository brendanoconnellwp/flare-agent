// Interactive SMS simulator — the primary dev loop (CLAUDE.md testing layer 1).
// Generates fake Twilio-shaped payloads and POSTs them to the local Worker's
// /webhook/sms, exactly as Twilio would, then prints the agent's replies.
//
//   pnpm chat                        talk as the default caller
//   pnpm chat --from +15557654321    simulate a different caller
//   pnpm chat --missed-call          start with a missed-call trigger (agent texts first)
//   pnpm chat --url http://...      target a non-default Worker
//   pnpm chat --replay <event-id>    re-POST a logged webhook event to local dev
//                                    (add --remote to fetch the event from the
//                                    production D1 instead of the local one)
//
// Type a message and hit enter; "exit" or Ctrl+C quits.

import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const args = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const from = flagValue("--from") ?? "+15551230001";
const to = flagValue("--to") ?? "+15550009999";
const base = (flagValue("--url") ?? "http://localhost:8787").replace(/\/$/, "");

function printReplies(replies: string[], heldUntil?: number): void {
  if (heldUntil !== undefined) {
    console.log(`(reply held until ${new Date(heldUntil).toLocaleString()} — quiet hours)`);
    return;
  }
  if (replies.length === 0) {
    console.log("(no reply — number is opted out or nothing to send)");
  }
  for (const reply of replies) {
    console.log(`agent> ${reply}`);
  }
}

// --replay <event-id>: fetch a logged webhook event (hard rule 8) and
// re-POST its exact payload to local dev over the simulator channel.
if (args.includes("--replay")) {
  const eventId = flagValue("--replay");
  if (!eventId || !/^[0-9A-Za-z]+$/.test(eventId)) {
    console.error("Usage: pnpm chat --replay <event-id> [--remote]");
    process.exit(1);
  }
  const where = args.includes("--remote") ? "--remote" : "--local";
  // One quoted command string: execFileSync with shell:true would split the
  // SQL on spaces under cmd.exe. eventId is regex-validated above.
  const sql = `SELECT source, payload FROM events WHERE id = '${eventId}'`;
  const out = execSync(`pnpm wrangler d1 execute missed-call-agent ${where} --json --command "${sql}"`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const results = (JSON.parse(out) as { results: { source: string; payload: string }[] }[])[0]?.results ?? [];
  const event = results[0];
  if (!event) {
    console.error(`No event ${eventId} in the ${where === "--remote" ? "remote" : "local"} events table.`);
    process.exit(1);
  }

  const payload = JSON.parse(event.payload) as Record<string, string>;
  const path = event.source.includes("voice")
    ? "/webhook/voice-status"
    : event.source.includes("missed_call")
      ? "/trigger/missed-call"
      : "/webhook/sms";
  console.log(`Replaying ${event.source} event ${eventId} → POST ${path}`);
  console.log(JSON.stringify(payload));

  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-channel": "simulator" },
    body: new URLSearchParams(payload),
  });
  if (!res.ok) {
    console.error(`Worker responded ${res.status}: ${await res.text()}`);
    process.exit(1);
  }
  const data = (await res.json()) as { replies: string[]; heldUntil?: number };
  printReplies(data.replies, data.heldUntil);
  process.exit(0);
}

function fakeMessageSid(): string {
  // "SIM" prefix so simulator traffic is recognizable in the events table.
  return `SIM${crypto.randomUUID().replaceAll("-", "")}`;
}

async function send(text: string): Promise<{ replies: string[]; heldUntil?: number }> {
  const res = await fetch(`${base}/webhook/sms`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-channel": "simulator",
    },
    body: new URLSearchParams({ From: from, To: to, Body: text, MessageSid: fakeMessageSid() }),
  });
  if (!res.ok) {
    throw new Error(`Worker responded ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as { replies: string[]; heldUntil?: number };
}

// Fail fast with a useful message if dev isn't running.
try {
  const health = await fetch(`${base}/health`);
  const info = (await health.json()) as { business: string; trade: string };
  console.log(`Connected to ${info.business} (${info.trade}) at ${base}`);
} catch {
  console.error(`Cannot reach ${base} — is \`pnpm dev\` running?`);
  process.exit(1);
}
console.log(`Texting as ${from} → ${to}. Type a message; "exit" quits.\n`);

// Simulate the missed call that starts a real conversation: the agent's
// deterministic firstMessage arrives before the caller types anything.
if (args.includes("--missed-call")) {
  const res = await fetch(`${base}/trigger/missed-call`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-channel": "simulator",
    },
    body: new URLSearchParams({ From: from }),
  });
  if (!res.ok) {
    console.error(`missed-call trigger failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const data = (await res.json()) as { replies: string[]; heldUntil?: number };
  printReplies(data.replies, data.heldUntil);
}

// The async iterator (not rl.question) so lines are buffered while a request
// is in flight — required for piped/scripted input, harmless for a TTY.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const prompt = `you (${from})> `;

process.stdout.write(prompt);
for await (const line of rl) {
  const text = line.trim();
  if (text === "exit") break;
  if (text !== "") {
    if (!process.stdin.isTTY) console.log(text); // echo piped input so transcripts read fully
    try {
      const data = await send(text);
      printReplies(data.replies, data.heldUntil);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.stdout.write(prompt);
}
rl.close();
process.exit(0);
