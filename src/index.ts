// Routes are thin: parse, normalize, delegate (CLAUDE.md).

import { Hono, type Context } from "hono";
import { z } from "zod";
import { createProvider } from "./agent/provider";
import { renderSimulatorReply } from "./channels/simulator";
import {
  renderTwiml,
  renderVoiceForwardTwiml,
  renderVoiceScreenAcceptTwiml,
  renderVoiceScreenTwiml,
  toInbound,
  TwilioSmsPayload,
  validateTwilioSignature,
} from "./channels/twilio";
import type { Channel } from "./channels/types";
import { loadConfig } from "./config/load";
import {
  renderDashboard,
  renderTranscript,
  type DashConversation,
  type DashLead,
  type DashMessage,
  type DashNotification,
} from "./dashboard/render";
import { constantTimeEqual } from "./lib/constant-time";
import { isNanpPhone } from "./lib/phone";
import { ulid } from "./lib/ulid";

const app = new Hono<{ Bindings: Env }>();

// Never leak stack traces or internals to callers; the log gets the detail.
app.onError((err, c) => {
  console.error(JSON.stringify({ event: "unhandled_error", path: c.req.path, error: String(err) }));
  return c.text("Internal error", 500);
});

// Hard rule 8: every inbound webhook payload is logged so production
// conversations are replayable as local fixtures. Off the hot path.
function logEvent(env: Env, source: string, payload: unknown): Promise<unknown> {
  return env.DB.prepare("INSERT INTO events (id, source, payload, created_at) VALUES (?, ?, ?, ?)")
    .bind(ulid(), source, JSON.stringify(payload), Date.now())
    .run();
}

type AppContext = Context<{ Bindings: Env }>;

// The simulator channel bypasses Twilio auth, so it must be explicitly
// enabled (ALLOW_SIMULATOR, set in .dev.vars and tests — never production).
function resolveChannel(c: AppContext): Channel {
  const simulator = c.req.header("x-channel") === "simulator" && String(c.env.ALLOW_SIMULATOR) === "true";
  return simulator ? "simulator" : "twilio";
}

// Twilio-channel requests must carry a valid X-Twilio-Signature. No
// configured auth token means no way to verify — reject rather than trust.
async function verifiedTwilioRequest(c: AppContext, form: Record<string, unknown>): Promise<boolean> {
  const token = c.env.TWILIO_AUTH_TOKEN;
  if (!token) return false;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(form)) {
    if (typeof value === "string") params[key] = value;
  }
  return validateTwilioSignature(token, c.req.url, params, c.req.header("x-twilio-signature") ?? "");
}

app.get("/health", (c) => {
  const config = loadConfig(c.env.VERTICAL);
  return c.json({
    ok: true,
    business: config.business.name,
    trade: config.business.trade,
  });
});

// Inbound SMS. Twilio and the simulator both post Twilio-shaped form
// payloads; the response is TwiML for Twilio, JSON for the simulator.
app.post("/webhook/sms", async (c) => {
  const form = await c.req.parseBody();
  const parsed = TwilioSmsPayload.safeParse(form);
  if (!parsed.success) {
    return c.text("Malformed SMS webhook payload", 400);
  }

  const channel = resolveChannel(c);
  if (channel === "twilio" && !(await verifiedTwilioRequest(c, form))) {
    return c.text("Invalid Twilio signature", 403);
  }

  const msg = toInbound(parsed.data, channel);
  // Source names the event TYPE + channel so --replay can route the payload
  // back to the right webhook.
  c.executionCtx.waitUntil(logEvent(c.env, channel === "simulator" ? "simulator_sms" : "twilio_sms", parsed.data));

  // SMS-pumping / toll-fraud guard: non-NANP callers are logged but never
  // answered — an auto-reply to a premium-rate number is the attack.
  if (!isNanpPhone(msg.from)) {
    return channel === "simulator"
      ? c.json(renderSimulatorReply([]))
      : c.body(renderTwiml([]), 200, { "Content-Type": "text/xml" });
  }

  const stub = c.env.CONVERSATION.getByName(msg.from);
  const { replies, heldUntil } = await stub.handleInbound(msg);

  if (channel === "simulator") {
    return c.json(renderSimulatorReply(replies, heldUntil));
  }
  return c.body(renderTwiml(replies), 200, { "Content-Type": "text/xml" });
});

// Voice webhook for the Twilio number: ring the owner; the <Dial> outcome
// lands on /webhook/voice-status below.
app.post("/twiml/voice", async (c) => {
  const form = await c.req.parseBody();
  if (resolveChannel(c) === "twilio" && !(await verifiedTwilioRequest(c, form))) {
    return c.text("Invalid Twilio signature", 403);
  }
  const config = loadConfig(c.env.VERTICAL);
  return c.body(renderVoiceForwardTwiml(config.business.ownerNotify.phone), 200, { "Content-Type": "text/xml" });
});

// Whisper screen on the forwarded leg: a human presses a key to accept; a
// voicemail can't, so the leg dies and the call counts as missed.
app.post("/twiml/voice-screen", async (c) => {
  const form = await c.req.parseBody();
  if (resolveChannel(c) === "twilio" && !(await verifiedTwilioRequest(c, form))) {
    return c.text("Invalid Twilio signature", 403);
  }
  return c.body(renderVoiceScreenTwiml(), 200, { "Content-Type": "text/xml" });
});

app.post("/twiml/voice-screen-accept", async (c) => {
  const form = await c.req.parseBody();
  if (resolveChannel(c) === "twilio" && !(await verifiedTwilioRequest(c, form))) {
    return c.text("Invalid Twilio signature", 403);
  }
  return c.body(renderVoiceScreenAcceptTwiml(), 200, { "Content-Type": "text/xml" });
});

// Call-status callback: a forwarded call nobody answered is a missed call →
// fire the instant firstMessage (sent via REST — there is no SMS response to
// ride on). "completed" means someone picked up; no text-back.
const TwilioVoiceStatusPayload = z.object({
  From: z.string().min(1),
  CallSid: z.string().min(1),
  CallStatus: z.string().optional(),
  DialCallStatus: z.string().optional(),
});
const MISSED_CALL_STATUSES = new Set(["no-answer", "busy", "failed"]);

app.post("/webhook/voice-status", async (c) => {
  const form = await c.req.parseBody();
  const parsed = TwilioVoiceStatusPayload.safeParse(form);
  if (!parsed.success) {
    return c.text("Malformed voice-status payload", 400);
  }

  const channel = resolveChannel(c);
  if (channel === "twilio" && !(await verifiedTwilioRequest(c, form))) {
    return c.text("Invalid Twilio signature", 403);
  }

  c.executionCtx.waitUntil(
    logEvent(c.env, channel === "simulator" ? "simulator_voice_status" : "twilio_voice_status", form)
  );

  const missed =
    MISSED_CALL_STATUSES.has(parsed.data.DialCallStatus ?? "") ||
    MISSED_CALL_STATUSES.has(parsed.data.CallStatus ?? "");

  let replies: string[] = [];
  let heldUntil: number | undefined;
  const from = parsed.data.From.trim();
  // Same toll-fraud guard as /webhook/sms: no text-backs outside NANP.
  if (missed && isNanpPhone(from)) {
    ({ replies, heldUntil } = await c.env.CONVERSATION.getByName(from).missedCall(from, channel));
  }

  if (channel === "simulator") {
    return c.json(renderSimulatorReply(replies, heldUntil));
  }
  // Twilio just needs a valid response; the firstMessage went via REST.
  return c.body('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', 200, {
    "Content-Type": "text/xml",
  });
});

// Simulator-only convenience trigger (pnpm chat --missed-call). Production
// missed calls arrive via /webhook/voice-status.
const MissedCallPayload = z.object({ From: z.string().min(1) });

app.post("/trigger/missed-call", async (c) => {
  const form = await c.req.parseBody();
  const parsed = MissedCallPayload.safeParse(form);
  if (!parsed.success) {
    return c.text("Malformed missed-call payload", 400);
  }
  if (resolveChannel(c) !== "simulator") {
    return c.text("Simulator channel disabled", 403);
  }

  c.executionCtx.waitUntil(logEvent(c.env, "simulator_missed_call", parsed.data));

  const from = parsed.data.From.trim();
  const { replies, heldUntil } = await c.env.CONVERSATION.getByName(from).missedCall(from, "simulator");
  return c.json(renderSimulatorReply(replies, heldUntil));
});

// Simulator-only model completion, used by the persona test harness
// (pnpm test:personas) to LLM-play the CALLER side without needing its own
// model credentials. 403 in production (ALLOW_SIMULATOR unset).
const SimCompletePayload = z.object({
  messages: z
    .array(z.object({ role: z.enum(["system", "user", "assistant"]), content: z.string() }))
    .min(1),
});

app.post("/sim/complete", async (c) => {
  if (resolveChannel(c) !== "simulator") {
    return c.text("Simulator channel disabled", 403);
  }
  const parsed = SimCompletePayload.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.text("Malformed completion payload", 400);
  }
  const text = await createProvider(c.env).complete(parsed.data.messages);
  return c.json({ text });
});

// ---------------------------------------------------------------------------
// Read-only owner dashboard. Off by default: without a DASHBOARD_TOKEN secret
// the routes 404. Auth is the token, either once as ?token= (which sets an
// HttpOnly cookie and redirects to a clean URL) or via that cookie.

const DASH_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" };

function dashboardAuth(c: AppContext): Response | null {
  const token = (c.env as { DASHBOARD_TOKEN?: string }).DASHBOARD_TOKEN;
  if (!token) return c.text("Not found", 404); // dashboard disabled: no token secret configured

  const provided = c.req.query("token");
  if (provided !== undefined) {
    if (!constantTimeEqual(provided, token)) return c.text("Invalid token", 403);
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/dashboard",
        "Set-Cookie": `dash=${token}; HttpOnly; Secure; SameSite=Lax; Path=/dashboard; Max-Age=2592000`,
      },
    });
  }

  const cookie = (c.req.header("cookie") ?? "").match(/(?:^|;\s*)dash=([^;]+)/)?.[1];
  if (cookie && constantTimeEqual(cookie, token)) return null; // authorized
  return c.text("Unauthorized. Open /dashboard?token=<DASHBOARD_TOKEN> once to sign in.", 401);
}

app.get("/dashboard", async (c) => {
  const denied = dashboardAuth(c);
  if (denied) return denied;
  const config = loadConfig(c.env.VERTICAL);

  const [leads, conversations, notifications] = await Promise.all([
    c.env.DB.prepare(
      "SELECT created_at, caller_name, caller_phone, service, urgency, location, summary, status FROM leads ORDER BY created_at DESC LIMIT 50"
    ).all<DashLead>(),
    c.env.DB.prepare(
      `SELECT c.id, c.caller_phone, c.status, c.urgency, c.scenario_id, c.last_message_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c ORDER BY c.last_message_at DESC LIMIT 50`
    ).all<DashConversation>(),
    c.env.DB.prepare("SELECT created_at, body FROM notifications ORDER BY created_at DESC LIMIT 20").all<DashNotification>(),
  ]);

  return c.body(renderDashboard(config, leads.results, conversations.results, notifications.results), 200, DASH_HEADERS);
});

app.get("/dashboard/c/:id", async (c) => {
  const denied = dashboardAuth(c);
  if (denied) return denied;
  const config = loadConfig(c.env.VERTICAL);

  const id = c.req.param("id");
  const conversation = await c.env.DB.prepare(
    `SELECT c.id, c.caller_phone, c.status, c.urgency, c.scenario_id, c.last_message_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
     FROM conversations c WHERE c.id = ?`
  )
    .bind(id)
    .first<DashConversation>();
  if (!conversation) return c.notFound();

  const messages = await c.env.DB.prepare(
    "SELECT direction, body, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at, id"
  )
    .bind(id)
    .all<DashMessage>();

  return c.body(renderTranscript(config, conversation, messages.results), 200, DASH_HEADERS);
});

export default app;
export { ConversationDO } from "./do/conversation";
