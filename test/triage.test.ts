// M3 acceptance suite: scripted conversations through the real engine
// (SELF.fetch → webhook → ConversationDO → D1), model mocked via the
// MODEL_PROVIDER=mock provider (vitest.config.ts), which pops scripted
// responses from the test_model_script table. Empty script = every model
// call fails. Owner notifications are asserted from the notifications table.
// Each test uses a distinct caller phone, so each gets its own DO.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIFE_SAFETY_RESPONSE } from "../src/engine/triage";
import plumbing from "../verticals/plumbing.json";

async function sms(from: string, body: string): Promise<string[]> {
  const res = await SELF.fetch("https://example.com/webhook/sms", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-channel": "simulator",
    },
    body: new URLSearchParams({
      From: from,
      To: "+15550009999",
      Body: body,
      MessageSid: `SIM${crypto.randomUUID()}`,
    }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { replies: string[] };
  return data.replies;
}

async function seedModel(...turns: object[]): Promise<void> {
  for (const turn of turns) {
    await env.DB.prepare("INSERT INTO test_model_script (response) VALUES (?)")
      .bind(JSON.stringify(turn))
      .run();
  }
}

async function unusedModelScripts(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM test_model_script").first<{ n: number }>();
  return row?.n ?? 0;
}

async function ownerNotifications(): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT body FROM notifications ORDER BY created_at").all<{
    body: string;
  }>();
  return results.map((r) => r.body);
}

function conversationRow(from: string) {
  return env.DB.prepare("SELECT status, urgency, scenario_id FROM conversations WHERE caller_phone = ?")
    .bind(from)
    .first<{ status: string; urgency: string | null; scenario_id: string | null }>();
}

describe("urgency triage + escalation", () => {
  it("escalates 'water everywhere' on the deterministic path even when the model fails", async () => {
    const from = "+15551110001";
    // No scripted responses: any model call would throw. The deterministic
    // layer must escalate anyway (hard rule 6).

    const replies = await sms(from, "help, there is water everywhere in my kitchen");

    // Caller gets the config's ack + the owner-approved guidance — no model involved.
    expect(replies[0]).toBe(plumbing.emergency.escalation.callerAck);
    expect(replies[1]).toBe(plumbing.emergency.scenarios[0]!.callerGuidance);

    // Owner got the interpolated ownerTemplate.
    const notified = await ownerNotifications();
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("EMERGENCY LEAD");
    expect(notified[0]).toContain("Burst / actively leaking pipe");
    expect(notified[0]).toContain(from);

    const conv = await conversationRow(from);
    expect(conv).toMatchObject({ status: "escalated", urgency: "emergency", scenario_id: "burst_pipe" });
  });

  it("answers 'I smell gas' with the engine's hardcoded life-safety response", async () => {
    const from = "+15551110002";

    const replies = await sms(from, "I smell gas near my water heater, what should I do?");

    expect(replies).toEqual([LIFE_SAFETY_RESPONSE]);
    expect(replies[0]).toContain("911");
    expect(replies[0]).toContain("leave the area");

    expect(await ownerNotifications()).toHaveLength(1);
    const conv = await conversationRow(from);
    expect(conv).toMatchObject({ status: "escalated", urgency: "emergency", scenario_id: "gas_water_heater" });
  });

  it("does not escalate a routine job", async () => {
    const from = "+15551110003";
    await seedModel({
      reply: "Happy to help with that faucet. What's the address or neighborhood?",
      state: { answered: { issue: "replace a bathroom faucet" }, urgency: "routine", done: false },
    });

    const replies = await sms(from, "hi, id like to get a new bathroom faucet installed next month");

    expect(replies).toEqual(["Happy to help with that faucet. What's the address or neighborhood?"]);
    expect(await unusedModelScripts()).toBe(0); // exactly one model call, no retry
    expect(await ownerNotifications()).toHaveLength(0);

    const conv = await conversationRow(from);
    expect(conv?.status).toBe("active");
    expect(conv?.urgency).toBe("routine");
    expect(conv?.scenario_id).toBeNull();
  });

  it("escalates a model-detected emergency ('my ceiling is raining') via the model path", async () => {
    const from = "+15551110004";
    await seedModel({
      reply: "That sounds serious — I'm getting someone on this now.",
      state: { answered: { issue: "water coming through the ceiling" }, urgency: "emergency", done: false },
    });

    // No config signal matches "raining" — only the model can catch this one.
    const replies = await sms(from, "my ceiling is raining");

    // The engine sends the config's callerAck, not the model's reply.
    expect(replies[0]).toBe(plumbing.emergency.escalation.callerAck);
    expect(await unusedModelScripts()).toBe(0);

    const notified = await ownerNotifications();
    expect(notified).toHaveLength(1);
    expect(notified[0]).toContain("Possible emergency (model-detected)");

    const conv = await conversationRow(from);
    expect(conv).toMatchObject({ status: "escalated", urgency: "emergency", scenario_id: null });
  });

  it("keeps a human in charge after escalation: later messages get a static ack, not the model", async () => {
    const from = "+15551110005";

    await sms(from, "water is gushing out of the wall");
    const replies = await sms(from, "should I try to unscrew the pipe myself??");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("on-call team has been alerted");
    // Owner was notified exactly once — no re-escalation spam.
    expect(await ownerNotifications()).toHaveLength(1);
  });

  it("catches a post-qualification emergency via the model — no canned brush-off", async () => {
    const from = "+15551110007";

    // Turn 1: caller answers everything at once; lead is captured, done=true.
    await seedModel({
      reply: "Thanks Pat, we'll have someone call you soon.",
      state: {
        answered: { issue: "water heater making noise", location: "Mira Mesa", timeline: "this week", name: "Pat" },
        service: "water heater repair or replacement",
        summary: "Pat in Mira Mesa, water heater making noise, this week",
        urgency: "routine",
        done: true,
      },
    });
    await sms(from, "water heater making noise, im in Mira Mesa, sometime this week, this is Pat");
    expect(await env.DB.prepare("SELECT id FROM leads WHERE caller_phone = ?").bind(from).first()).not.toBeNull();

    // Turn 2: the situation worsens, phrased to miss every config signal.
    // Only the model can catch this — the done state must not skip it.
    // (Production found this: the engine used to reply "we've got your
    // details" without consulting the model.)
    await seedModel({
      reply: "That's an emergency — getting someone on this now.",
      state: { answered: {}, urgency: "emergency", done: true },
    });
    const replies = await sms(from, "actually theres now a big puddle spreading across my floor");

    expect(replies[0]).toBe(plumbing.emergency.escalation.callerAck);
    const conv = await conversationRow(from);
    expect(conv).toMatchObject({ status: "escalated", urgency: "emergency" });
    expect((await ownerNotifications()).some((n) => n.includes("EMERGENCY LEAD"))).toBe(true);
  });

  it("still honors STOP in an escalated conversation", async () => {
    const from = "+15551110006";

    await sms(from, "sewage is backing up into my tub");
    const stopReplies = await sms(from, "STOP");
    expect(stopReplies).toHaveLength(1);
    expect(stopReplies[0]).toContain("unsubscribed");

    const after = await sms(from, "hello?");
    expect(after).toEqual([]);
  });
});
