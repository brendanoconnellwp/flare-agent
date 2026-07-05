// Persona tests (CLAUDE.md testing layer 3): LLM-played callers run against
// the REAL engine — real model, real DO, real D1 — via a dedicated wrangler
// dev instance. Transcripts land in test-output/; each persona is auto-graded
// on its terminal state (escalated when it should? lead captured? STOP
// honored? no prices quoted?). Exit code 1 if any persona fails.
//
//   pnpm test:personas                  spawn a dev server on :8788 and run all
//   pnpm test:personas --url http://... run against an existing server
//   pnpm test:personas --only stop-mid-flow

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
function flagValue(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const PORT = 8788;
const externalUrl = flagValue("--url");
const BASE = (externalUrl ?? `http://localhost:${PORT}`).replace(/\/$/, "");
// Midday Pacific: quiet hours never hold persona conversations.
const FIXED_NOW = "2026-07-01T19:00:00Z";
const OUT_DIR = join(import.meta.dirname, "..", "test-output");

// ---------- infrastructure ----------

function startDevServer(): ChildProcess {
  console.log(`Starting wrangler dev on :${PORT} (policy clock pinned to ${FIXED_NOW})...`);
  // Single command string: shell:true with an args array is deprecated
  // (args are concatenated unescaped). All parts here are static.
  return spawn(`pnpm wrangler dev --port ${PORT} --var TEST_FIXED_NOW:${FIXED_NOW}`, {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function stopDevServer(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  } else {
    child.kill();
  }
}

async function waitForHealth(): Promise<void> {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Dev server never became healthy at ${BASE}`);
}

function d1Query<T>(sql: string): T[] {
  const out = execSync(`pnpm wrangler d1 execute missed-call-agent --local --json --command "${sql}"`, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return (JSON.parse(out) as { results: T[] }[])[0]?.results ?? [];
}

async function post(path: string, form: Record<string, string>): Promise<{ replies: string[]; heldUntil?: number }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-channel": "simulator" },
    body: new URLSearchParams(form),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as { replies: string[]; heldUntil?: number };
}

// The caller side is played by the same model the agent uses, via the
// simulator-only /sim/complete route — no separate credentials needed.
async function llmCallerNext(callerSystem: string, transcript: Turn[]): Promise<string> {
  const messages = [
    {
      role: "system" as const,
      content:
        `${callerSystem}\n\n` +
        "You are the CUSTOMER in an SMS conversation. Reply with ONLY the customer's next text message — no quotes, no narration, under 160 characters, informal texting style. " +
        "If the business says someone will call you, has your details, or has alerted their on-call team, reply with exactly: DONE",
    },
    // From the caller-LLM's perspective, the agent is the interlocutor.
    ...transcript.map((t) => ({
      role: t.who === "agent" ? ("user" as const) : ("assistant" as const),
      content: t.text,
    })),
  ];
  const res = await fetch(`${BASE}/sim/complete`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-channel": "simulator" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`/sim/complete → ${res.status}: ${await res.text()}`);
  const { text } = (await res.json()) as { text: string };
  return text.trim().replace(/^["']+|["']+$/g, "");
}

// ---------- personas ----------

interface Turn {
  who: "agent" | "caller";
  text: string;
}

interface Terminal {
  conversation: { status: string; urgency: string | null; scenario_id: string | null } | undefined;
  lead: { caller_name: string | null; service: string | null; urgency: string; summary: string } | undefined;
  optedOut: boolean;
  outbound: string[]; // agent message bodies, in order
  notifications: string[]; // owner alerts mentioning this phone
}

interface Persona {
  name: string;
  description: string;
  // LLM caller personality + scenario (used when script returns undefined).
  callerSystem: string;
  // Scripted turns for determinism; return undefined to hand over to the LLM,
  // "END" to stop the conversation.
  script?: (turn: number) => string | undefined;
  maxTurns: number;
  grade: (t: Terminal) => string[]; // failure descriptions; empty = pass
}

const PERSONAS: Persona[] = [
  {
    name: "panicked-burst-pipe",
    description: "burst pipe, ALL CAPS panic — must escalate",
    callerSystem:
      "Personality: panicked homeowner, typing fast, ALL CAPS, typos. Scenario: a pipe just burst under your kitchen sink and water is gushing out all over the floor. You want help NOW.",
    maxTurns: 4,
    grade: (t) => {
      const fails: string[] = [];
      if (t.conversation?.status !== "escalated") fails.push(`status is ${t.conversation?.status}, expected escalated`);
      if (t.conversation?.urgency !== "emergency") fails.push(`urgency is ${t.conversation?.urgency}, expected emergency`);
      if (t.notifications.length === 0) fails.push("owner was never notified");
      return fails;
    },
  },
  {
    name: "vague-one-worder",
    description: "answers in 1–3 words — must still capture a lead",
    callerSystem:
      "Personality: distracted, terse — you answer every question with one to three words maximum ('toilet', 'keeps running', 'mira mesa', 'this week', 'pat'). Never volunteer extra info, never use words like flooding or burst. Scenario: your toilet keeps running, you live in Mira Mesa, you want it fixed this week, your name is Pat.",
    maxTurns: 8,
    grade: (t) => {
      const fails: string[] = [];
      if (!t.lead) fails.push("no lead captured");
      if (t.conversation?.status === "escalated") fails.push("escalated a routine running toilet");
      return fails;
    },
  },
  {
    name: "tire-kicker",
    description: "price shopper — agent must never quote a price",
    callerSystem:
      "Personality: price-obsessed comparison shopper. Scenario: you want a new water heater eventually and are collecting quotes. Ask what it costs in different ways at least twice ('how much roughly', 'ballpark?'). Be evasive about your address the first time you're asked, then give 'Clairemont'. Your name is Jordan. Timeline: 'just getting quotes'.",
    maxTurns: 8,
    grade: (t) => {
      const fails: string[] = [];
      const priced = t.outbound.filter((m) => /\$\s?\d/.test(m));
      if (priced.length > 0) fails.push(`agent quoted a price: "${priced[0]}"`);
      if (t.conversation?.status === "escalated") fails.push("escalated a quote request");
      if (t.outbound.length > 11) fails.push(`sent ${t.outbound.length} messages, over the maxAgentMessages budget`);
      return fails;
    },
  },
  {
    name: "answers-everything-first-message",
    description: "one dense message with all answers — no re-asking",
    callerSystem:
      "Personality: efficient. If asked anything you already said, politely repeat it briefly. Your name is Dana Smith, you're at 4415 Rose St in North Park, water heater drips a little at the bottom, want someone this week.",
    script: (turn) =>
      turn === 1
        ? "Hi, this is Dana Smith at 4415 Rose St in North Park. My water heater is dripping a little at the bottom — nothing urgent, but I'd like someone out this week."
        : undefined,
    maxTurns: 5,
    grade: (t) => {
      const fails: string[] = [];
      if (!t.lead) fails.push("no lead captured");
      if (t.conversation?.status === "escalated") fails.push("escalated a routine drip");
      // firstMessage + at most ~3 agent turns; 10 would mean it re-asked everything.
      if (t.outbound.length > 6) fails.push(`took ${t.outbound.length} agent messages for a fully-answered lead`);
      return fails;
    },
  },
  {
    name: "mid-conversation-emergency",
    description: "starts routine, then 'now it's spraying water everywhere' — must escalate mid-flow",
    callerSystem: "unused (fully scripted)",
    script: (turn) => {
      if (turn === 1) return "hey my water heater is making a weird rumbling noise";
      if (turn === 2) return "actually now its spraying water everywhere, the garage is flooding!!";
      return "END";
    },
    maxTurns: 3,
    grade: (t) => {
      const fails: string[] = [];
      if (t.conversation?.status !== "escalated") fails.push(`status is ${t.conversation?.status}, expected escalated`);
      if (t.notifications.length === 0) fails.push("owner was never notified");
      return fails;
    },
  },
  {
    name: "stop-mid-flow",
    description: "opts out mid-conversation — confirm once, then silence",
    callerSystem: "unused (fully scripted)",
    script: (turn) => {
      if (turn === 1) return "how much to install a bathroom faucet i bought";
      if (turn === 2) return "STOP";
      if (turn === 3) return "actually wait"; // must get NO reply
      return "END";
    },
    maxTurns: 4,
    grade: (t) => {
      const fails: string[] = [];
      if (!t.optedOut) fails.push("no opt_outs row");
      if (t.conversation?.status !== "opted_out") fails.push(`status is ${t.conversation?.status}, expected opted_out`);
      const confirmations = t.outbound.filter((m) => m.includes("unsubscribed"));
      if (confirmations.length !== 1) fails.push(`${confirmations.length} STOP confirmations, expected exactly 1`);
      const last = t.outbound[t.outbound.length - 1];
      if (last !== undefined && !last.includes("unsubscribed")) {
        fails.push(`agent messaged after opt-out: "${last}"`);
      }
      return fails;
    },
  },
];

// ---------- runner ----------

function terminalState(phone: string): Terminal {
  const conversation = d1Query<{ status: string; urgency: string | null; scenario_id: string | null }>(
    `SELECT status, urgency, scenario_id FROM conversations WHERE caller_phone = '${phone}'`
  )[0];
  const lead = d1Query<{ caller_name: string | null; service: string | null; urgency: string; summary: string }>(
    `SELECT caller_name, service, urgency, summary FROM leads WHERE caller_phone = '${phone}'`
  )[0];
  const optedOut = d1Query<{ n: number }>(`SELECT COUNT(*) AS n FROM opt_outs WHERE phone = '${phone}'`)[0]!.n > 0;
  const outbound = d1Query<{ body: string }>(
    `SELECT body FROM messages JOIN conversations ON conversations.id = messages.conversation_id WHERE caller_phone = '${phone}' AND direction = 'outbound' ORDER BY messages.created_at`
  ).map((r) => r.body);
  const notifications = d1Query<{ body: string }>(
    `SELECT body FROM notifications WHERE body LIKE '%${phone}%'`
  ).map((r) => r.body);
  return { conversation, lead, optedOut, outbound, notifications };
}

async function runPersona(persona: Persona): Promise<{ passed: boolean; transcriptPath: string }> {
  const phone = `+1999${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  const transcript: Turn[] = [];
  const record = (who: Turn["who"], text: string) => transcript.push({ who, text });

  // Every real conversation starts with a missed call.
  const first = await post("/trigger/missed-call", { From: phone });
  for (const r of first.replies) record("agent", r);

  for (let turn = 1; turn <= persona.maxTurns; turn++) {
    let message = persona.script?.(turn);
    if (message === "END") break;
    if (message === undefined) {
      message = await llmCallerNext(persona.callerSystem, transcript);
    }
    if (message === "" || /^DONE\b/i.test(message)) break;

    record("caller", message);
    const { replies } = await post("/webhook/sms", {
      From: phone,
      To: "+15550009999",
      Body: message,
      MessageSid: `SIM${crypto.randomUUID()}`,
    });
    for (const r of replies) record("agent", r);
  }

  const terminal = terminalState(phone);
  const failures = persona.grade(terminal);
  const passed = failures.length === 0;

  const lines = [
    `persona: ${persona.name} — ${persona.description}`,
    `caller:  ${phone}`,
    `result:  ${passed ? "PASS" : "FAIL"}`,
    ...failures.map((f) => `  ✗ ${f}`),
    "",
    ...transcript.map((t) => `${t.who === "agent" ? "agent > " : "caller> "}${t.text}`),
    "",
    "terminal state:",
    JSON.stringify(terminal, null, 2),
  ];
  const transcriptPath = join(OUT_DIR, `${persona.name}.txt`);
  writeFileSync(transcriptPath, lines.join("\n"));

  console.log(`${passed ? "✓" : "✗"} ${persona.name}${passed ? "" : `  — ${failures.join("; ")}`}`);
  return { passed, transcriptPath };
}

// ---------- main ----------

mkdirSync(OUT_DIR, { recursive: true });
const only = flagValue("--only");
const selected = only ? PERSONAS.filter((p) => p.name === only) : PERSONAS;
if (selected.length === 0) {
  console.error(`Unknown persona "${only}". Available: ${PERSONAS.map((p) => p.name).join(", ")}`);
  process.exit(1);
}

const server = externalUrl ? null : startDevServer();
let failed = 0;
try {
  await waitForHealth();
  console.log(`Running ${selected.length} persona(s) against ${BASE}; transcripts → test-output/\n`);
  for (const persona of selected) {
    const { passed } = await runPersona(persona);
    if (!passed) failed++;
  }
} finally {
  if (server) stopDevServer(server);
}

console.log(`\n${selected.length - failed}/${selected.length} personas passed.`);
process.exit(failed > 0 ? 1 : 0);
