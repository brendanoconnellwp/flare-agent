// One Durable Object per conversation, keyed by caller phone number
// (env.CONVERSATION.getByName(from)). The DO owns conversation state and
// history (hot path, SQLite storage); D1 is the system of record.
//
// Message flow: compliance (STOP/HELP, engine-owned) → opt-out gate → agent
// turn (model via provider adapter) → lead capture when every required
// qualification field is answered.

import { DurableObject } from "cloudflare:workers";
import { buildSystemPrompt } from "../agent/prompt";
import { createProvider, type ChatMessage } from "../agent/provider";
import { runAgentTurn } from "../agent/turn";
import { sendSms } from "../channels/twilio";
import type { Channel, InboundSms } from "../channels/types";
import { loadConfig } from "../config/load";
import type { VerticalConfig } from "../config/schema";
import { complianceKeyword, helpText, stopConfirmation } from "../engine/compliance";
import { inQuietHours, isWithinBusinessHours, msUntilQuietHoursEnd } from "../engine/hours";
import { engineNow } from "../lib/clock";
import { notifyOwner } from "../engine/notify";
import {
  LIFE_SAFETY_RESPONSE,
  matchEmergencySignals,
  raiseUrgency,
  type EmergencyScenario,
  type Urgency,
} from "../engine/triage";
import { interpolate } from "../lib/template";
import { ulid } from "../lib/ulid";

// Type alias (not interface) so it satisfies sql.exec's Record constraint
// via TypeScript's implicit index signature.
type ConversationMeta = {
  id: string;
  caller_phone: string;
  status: string;
  started_at: number;
};

// Cross-turn agent memory. Small, JSON-serializable, lives in DO KV storage.
interface AgentState {
  answered: Record<string, string>;
  service?: string;
  urgency?: Urgency;
  escalated?: boolean;
  scenarioId?: string;
  done: boolean;
  leadId?: string;
  // Set once the maxAgentMessages wrap-up has been sent; after that the
  // conversation goes silent instead of auto-replying forever.
  budgetClosed?: boolean;
}

export class ConversationDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          id TEXT PRIMARY KEY,
          caller_phone TEXT NOT NULL,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS history (
          id TEXT PRIMARY KEY,
          direction TEXT NOT NULL,   -- inbound | outbound | system
          body TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS held_messages (
          id TEXT PRIMARY KEY,       -- ulid; insertion order = delivery order
          body TEXT NOT NULL,
          channel TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS processed_messages (
          sid TEXT PRIMARY KEY,      -- provider MessageSid: webhook retry dedup
          created_at INTEGER NOT NULL
        );
      `);
    });
  }

  // Single entry point for a caller message. Returns the outbound replies
  // (possibly empty — e.g. the caller is opted out, or the reply is held for
  // quiet hours) for the channel adapter to render.
  async handleInbound(msg: InboundSms): Promise<{ replies: string[]; heldUntil?: number }> {
    const config = loadConfig(this.env.VERTICAL);
    const now = Date.now();

    // Twilio retries webhook deliveries; a MessageSid we've already processed
    // is a no-op (the original delivery carried the reply).
    const seen = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM processed_messages WHERE sid = ?", msg.messageSid)
      .one().n;
    if (Number(seen) > 0) {
      return { replies: [] };
    }
    this.ctx.storage.sql.exec("INSERT INTO processed_messages (sid, created_at) VALUES (?, ?)", msg.messageSid, now);

    const conv = await this.getOrCreateConversation(msg.from, now);

    await this.recordMessage(conv, "inbound", msg.text, msg.channel, now);

    const keyword = complianceKeyword(msg.text);

    if (keyword === "stop") {
      return { replies: await this.handleStop(conv, msg, config.business.name) };
    }

    // Compliance gate: nothing goes out to an opted-out number, ever.
    // Checked before EVERY outbound — the caller may have opted out in an
    // earlier conversation.
    if (await this.isOptedOut(msg.from)) {
      return { replies: [] };
    }

    let replies: string[];
    let exempt: boolean; // compliance and emergencies always send (hard rule 5 / spec M4)
    if (keyword === "help") {
      replies = [helpText(config.business.name, config.business.trade, config.business.serviceArea)];
      exempt = true;
    } else {
      replies = await this.engineTurn(conv, msg, config);
      const state = await this.ctx.storage.get<AgentState>("agentState");
      exempt = state?.escalated === true || state?.urgency === "emergency";
    }

    // Quiet-hours hold for non-emergency outbound (TCPA hygiene). Held
    // messages are delivered by the alarm when the window ends.
    const policyNow = new Date(engineNow(this.env));
    if (!exempt && replies.length > 0 && inQuietHours(config.policies.quietHours, config.business.hours.timezone, policyNow)) {
      const heldUntil = await this.holdMessages(replies, msg.channel, config);
      return { replies: [], heldUntil };
    }

    for (const reply of replies) {
      await this.recordMessage(conv, "outbound", reply, msg.channel, Date.now());
    }
    return { replies };
  }

  // Missed-call trigger: the instant text-back. Deterministic by design — no
  // model call stands between the missed call and the first message. On the
  // twilio channel the message goes out via REST (a voice status callback has
  // no SMS response to ride on).
  async missedCall(from: string, channel: Channel): Promise<{ replies: string[]; heldUntil?: number }> {
    const config = loadConfig(this.env.VERTICAL);
    if (await this.isOptedOut(from)) return { replies: [] };

    const now = Date.now();
    const conv = await this.getOrCreateConversation(from, now);

    // Twilio fires several callbacks per call (and retries); one text-back
    // per missed call is plenty.
    const lastOutbound = this.ctx.storage.sql
      .exec<{ at: number | null }>("SELECT MAX(created_at) AS at FROM history WHERE direction = 'outbound'")
      .one().at;
    if (lastOutbound !== null && now - lastOutbound < 60_000) {
      return { replies: [] };
    }
    // A firstMessage already waiting out quiet hours also counts as sent —
    // two missed calls overnight must not queue two identical text-backs.
    const heldCount = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM held_messages")
      .one().n;
    if (Number(heldCount) > 0) {
      return { replies: [] };
    }

    const text = interpolate(config.voice.firstMessage, { businessName: config.business.name });

    // The first text-back is non-emergency outbound: quiet hours hold it.
    const policyNow = new Date(engineNow(this.env));
    if (inQuietHours(config.policies.quietHours, config.business.hours.timezone, policyNow)) {
      const heldUntil = await this.holdMessages([text], channel, config);
      return { replies: [], heldUntil };
    }

    if (channel === "twilio") {
      await sendSms(this.env, from, text);
    }
    await this.recordMessage(conv, "outbound", text, channel, Date.now());
    return { replies: [text] };
  }

  // Queue outbound for delivery when quiet hours end. setAlarm replaces any
  // existing alarm, which is fine: the recomputed end-of-window is the same
  // or later, and the alarm drains the whole queue.
  private async holdMessages(texts: string[], channel: Channel, config: VerticalConfig): Promise<number> {
    const now = engineNow(this.env);
    for (const text of texts) {
      this.ctx.storage.sql.exec(
        "INSERT INTO held_messages (id, body, channel, created_at) VALUES (?, ?, ?, ?)",
        ulid(now),
        text,
        channel,
        now
      );
    }
    const heldUntil =
      now + msUntilQuietHoursEnd(config.policies.quietHours, config.business.hours.timezone, new Date(now));
    await this.ctx.storage.setAlarm(heldUntil);
    console.log(JSON.stringify({ event: "messages_held", count: texts.length, until: new Date(heldUntil).toISOString() }));
    return heldUntil;
  }

  // Quiet-hours drain: deliver held messages, oldest first. The opt-out gate
  // runs again here — the caller may have texted STOP while messages waited.
  async alarm(): Promise<void> {
    const conv = this.ctx.storage.sql
      .exec<ConversationMeta>("SELECT id, caller_phone, status, started_at FROM meta LIMIT 1")
      .toArray()[0];
    if (!conv) return;

    const held = this.ctx.storage.sql
      .exec<{ id: string; body: string; channel: string; created_at: number }>(
        "SELECT id, body, channel, created_at FROM held_messages ORDER BY id"
      )
      .toArray();
    if (held.length === 0) return;

    if (await this.isOptedOut(conv.caller_phone)) {
      this.ctx.storage.sql.exec("DELETE FROM held_messages");
      return;
    }

    for (const message of held) {
      // A message that has failed to deliver for 12h is stale, and Twilio
      // bills even blocked attempts — drop it instead of retrying forever.
      if (Date.now() - message.created_at > 12 * 60 * 60_000) {
        console.error(JSON.stringify({ event: "held_message_expired", body: message.body.slice(0, 80) }));
        this.ctx.storage.sql.exec("DELETE FROM held_messages WHERE id = ?", message.id);
        continue;
      }
      if (message.channel === "twilio") {
        try {
          await sendSms(this.env, conv.caller_phone, message.body);
        } catch (err) {
          // Keep this and later messages queued; retry in 5 minutes.
          console.error(JSON.stringify({ event: "held_delivery_failed", error: String(err) }));
          await this.ctx.storage.setAlarm(Date.now() + 5 * 60_000);
          return;
        }
      }
      await this.recordMessage(conv, "outbound", message.body, message.channel as Channel, Date.now());
      this.ctx.storage.sql.exec("DELETE FROM held_messages WHERE id = ?", message.id);
    }
  }

  // One engine turn: deterministic triage first, model second. Always returns
  // something sendable — model failure degrades to a safe fallback plus an
  // owner ping, never silence.
  private async engineTurn(conv: ConversationMeta, msg: InboundSms, config: VerticalConfig): Promise<string[]> {
    const state = (await this.ctx.storage.get<AgentState>("agentState")) ?? { answered: {}, done: false };

    // DETERMINISTIC LAYER FIRST (hard rule 6): a config signal hit escalates
    // immediately — no model call stands between an emergency and the owner.
    const hit = matchEmergencySignals(config, msg.text);
    if (hit && !state.escalated) {
      return this.escalate(conv, msg, state, config, hit);
    }

    // Already escalated: a human owns this conversation now. Deterministic
    // ack, no model.
    if (state.escalated) {
      return [
        `${config.business.name}: the on-call team has been alerted and someone will call you shortly. Reply here if anything changes.`,
      ];
    }

    // NOTE: qualified ("done") conversations deliberately still flow through
    // the model below. A caller whose situation worsens after the lead was
    // captured ("now there is water all over my floor") may not hit any
    // config signal — the model's urgency read is the only remaining net,
    // and a canned ack here would brush off an emergency (hard rule 4:
    // safety over helpfulness). Found in production; do not "optimize" this.

    // Engine-enforced message budget (policies.maxAgentMessages): capture
    // whatever we have, send ONE wrap-up, then go silent. Auto-replying to
    // every further message would let a hostile texter run up per-message
    // costs indefinitely (deterministic emergency signals above still work).
    if (this.countOutbound() >= config.policies.maxAgentMessages) {
      if (state.budgetClosed) {
        return [];
      }
      state.budgetClosed = true;
      await this.finalizeLead(conv, msg.from, state, config);
      await this.ctx.storage.put("agentState", state);
      return [`Thanks — ${config.business.name} will follow up with you shortly.`];
    }

    const system = buildSystemPrompt(config, state.answered);
    const timeoutMs = Number((this.env as { MODEL_TIMEOUT_MS?: string }).MODEL_TIMEOUT_MS ?? 20_000);
    const turn = await runAgentTurn(createProvider(this.env), system, this.chatHistory(), timeoutMs);

    if (!turn) {
      await notifyOwner(
        this.env,
        config,
        `⚠️ Model failure while texting ${msg.from}. The caller is waiting — check the conversation and call them.`
      );
      return [`Thanks for the details — a team member from ${config.business.name} will text you shortly.`];
    }

    state.answered = { ...state.answered, ...turn.state.answered };
    if (turn.state.service) state.service = turn.state.service;

    // MODEL LAYER SECOND: the model can raise urgency (an emergency described
    // in words the signals missed) but can never lower a deterministic hit —
    // those escalated above without ever reaching this code.
    if (turn.state.urgency === "emergency") {
      return this.escalate(conv, msg, state, config, null);
    }
    const raised = raiseUrgency(state.urgency, turn.state.urgency);
    if (raised !== state.urgency) {
      state.urgency = raised;
      await this.env.DB.prepare("UPDATE conversations SET urgency = ? WHERE id = ?").bind(raised ?? null, conv.id).run();
    }

    const required = config.qualification.filter((q) => q.required).map((q) => q.id);
    const complete = required.every((id) => (state.answered[id] ?? "") !== "");
    if (complete) {
      await this.finalizeLead(conv, msg.from, state, config, turn.state.summary);
    } else {
      await this.ctx.storage.put("agentState", state);
    }
    return [turn.reply];
  }

  // Escalation: owner gets the interpolated ownerTemplate, the caller gets
  // callerAck (+ owner-approved guidance), the conversation is marked
  // escalated. Life-safety scenarios use the engine's hardcoded language —
  // the model does not compose that message (spec M3, hard rule 4).
  private async escalate(
    conv: ConversationMeta,
    msg: InboundSms,
    state: AgentState,
    config: VerticalConfig,
    scenario: EmergencyScenario | null
  ): Promise<string[]> {
    state.escalated = true;
    state.urgency = "emergency";
    if (scenario) state.scenarioId = scenario.id;
    await this.ctx.storage.put("agentState", state);

    this.ctx.storage.sql.exec("UPDATE meta SET status = 'escalated'");
    await this.env.DB.prepare(
      "UPDATE conversations SET status = 'escalated', urgency = 'emergency', scenario_id = ? WHERE id = ?"
    )
      .bind(scenario?.id ?? null, conv.id)
      .run();

    await notifyOwner(
      this.env,
      config,
      interpolate(config.emergency.escalation.ownerTemplate, {
        summary: this.escalationSummary(state, msg.text, config),
        phone: msg.from,
        scenario: scenario?.label ?? "Possible emergency (model-detected)",
      })
    );

    if (scenario?.lifeSafety) {
      return [LIFE_SAFETY_RESPONSE];
    }

    const replies = [config.emergency.escalation.callerAck];
    if (scenario?.callerGuidance) replies.push(scenario.callerGuidance);
    if (
      config.emergency.afterHours === "escalate_and_set_expectation" &&
      !isWithinBusinessHours(config.business.hours, new Date())
    ) {
      replies.push(
        "Heads up: we're currently closed, so it may take a little longer than usual — but the on-call team has been alerted."
      );
    }
    return replies;
  }

  private escalationSummary(state: AgentState, triggerText: string, config: VerticalConfig): string {
    const details = config.qualification
      .map((q) => state.answered[q.id])
      .filter((v): v is string => Boolean(v))
      .join(" · ");
    const trigger = triggerText.length > 160 ? `${triggerText.slice(0, 157)}...` : triggerText;
    return details ? `"${trigger}" (${details})` : `"${trigger}"`;
  }

  // Lead capture: write to D1, notify the owner, mark the conversation
  // qualified. Idempotent — at most one lead per conversation.
  // caller_name/location columns map to the conventional question ids "name"
  // and "location" when the config uses them; other ids surface via summary.
  private async finalizeLead(
    conv: ConversationMeta,
    phone: string,
    state: AgentState,
    config: VerticalConfig,
    modelSummary?: string
  ): Promise<void> {
    if (state.leadId) return;

    const id = ulid();
    const summary = modelSummary?.trim() || this.composeSummary(state, config);
    await this.env.DB.prepare(
      `INSERT INTO leads (id, conversation_id, caller_phone, caller_name, service, urgency, location, summary, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`
    )
      .bind(
        id,
        conv.id,
        phone,
        state.answered["name"] ?? null,
        state.service ?? null,
        state.urgency ?? "routine",
        state.answered["location"] ?? null,
        summary,
        Date.now()
      )
      .run();

    state.leadId = id;
    state.done = true;
    await this.ctx.storage.put("agentState", state);
    await this.setStatus(conv, "qualified");

    const name = state.answered["name"];
    await notifyOwner(this.env, config, `New lead: ${summary} — ${phone}${name ? ` (${name})` : ""}`);
    await this.env.DB.prepare("UPDATE leads SET status = 'notified' WHERE id = ?").bind(id).run();
  }

  private composeSummary(state: AgentState, config: VerticalConfig): string {
    const details = config.qualification
      .map((q) => state.answered[q.id])
      .filter((v): v is string => Boolean(v))
      .join(" · ");
    return `${state.service ?? `${config.business.trade} request`}: ${details || "no details captured"}`;
  }

  private chatHistory(): ChatMessage[] {
    return this.ctx.storage.sql
      .exec<{ direction: string; body: string }>(
        "SELECT direction, body FROM history WHERE direction IN ('inbound', 'outbound') ORDER BY created_at, id"
      )
      .toArray()
      .map((row) => ({
        role: row.direction === "inbound" ? ("user" as const) : ("assistant" as const),
        content: row.body,
      }));
  }

  private countOutbound(): number {
    return Number(
      this.ctx.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM history WHERE direction = 'outbound'").one().n
    );
  }

  // STOP: persist the opt-out first (crash-safe: worst case we stay silent),
  // confirm exactly once — only when this insert actually created the row —
  // then never message this number again.
  private async handleStop(conv: ConversationMeta, msg: InboundSms, businessName: string): Promise<string[]> {
    const result = await this.env.DB.prepare(
      "INSERT INTO opt_outs (phone, created_at) VALUES (?, ?) ON CONFLICT (phone) DO NOTHING"
    )
      .bind(msg.from, Date.now())
      .run();
    const newlyOptedOut = result.meta.changes > 0;

    await this.setStatus(conv, "opted_out");

    if (!newlyOptedOut) return [];
    const confirmation = stopConfirmation(businessName);
    await this.recordMessage(conv, "outbound", confirmation, msg.channel, Date.now());
    return [confirmation];
  }

  private async isOptedOut(phone: string): Promise<boolean> {
    const row = await this.env.DB.prepare("SELECT 1 AS x FROM opt_outs WHERE phone = ?").bind(phone).first();
    return row !== null;
  }

  private async getOrCreateConversation(callerPhone: string, now: number): Promise<ConversationMeta> {
    const existing = this.ctx.storage.sql
      .exec<ConversationMeta>("SELECT id, caller_phone, status, started_at FROM meta LIMIT 1")
      .toArray()[0];
    if (existing) return existing;

    const conv: ConversationMeta = {
      id: ulid(now),
      caller_phone: callerPhone,
      status: "active",
      started_at: now,
    };
    this.ctx.storage.sql.exec(
      "INSERT INTO meta (id, caller_phone, status, started_at) VALUES (?, ?, ?, ?)",
      conv.id,
      conv.caller_phone,
      conv.status,
      conv.started_at
    );
    // Awaited (not waitUntil): messages reference this row by FK, so it must
    // land in D1 before the first recordMessage write.
    await this.env.DB.prepare(
      "INSERT INTO conversations (id, caller_phone, status, started_at, last_message_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING"
    )
      .bind(conv.id, conv.caller_phone, conv.status, conv.started_at, now)
      .run();
    return conv;
  }

  private async setStatus(conv: ConversationMeta, status: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE meta SET status = ?", status);
    await this.env.DB.prepare("UPDATE conversations SET status = ? WHERE id = ?").bind(status, conv.id).run();
  }

  // Every message is written to DO history (hot path) and mirrored to D1
  // (system of record) in the same call.
  private async recordMessage(
    conv: ConversationMeta,
    direction: "inbound" | "outbound",
    body: string,
    channel: Channel,
    at: number
  ): Promise<void> {
    const id = ulid(at);
    this.ctx.storage.sql.exec(
      "INSERT INTO history (id, direction, body, created_at) VALUES (?, ?, ?, ?)",
      id,
      direction,
      body,
      at
    );
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO messages (id, conversation_id, direction, body, channel, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(id, conv.id, direction, body, channel, at),
      this.env.DB.prepare("UPDATE conversations SET last_message_at = ? WHERE id = ?").bind(at, conv.id),
    ]);
  }
}
