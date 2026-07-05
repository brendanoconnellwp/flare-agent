// M5 failure modes: model timeout → fallback + owner ping; duplicate webhook
// delivery → idempotent on MessageSid; concurrent messages → DO serialization;
// replaying logged events never crashes.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import plumbing from "../verticals/plumbing.json";

async function sms(from: string, body: string, messageSid?: string) {
  const res = await SELF.fetch("https://example.com/webhook/sms", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-channel": "simulator" },
    body: new URLSearchParams({
      From: from,
      To: "+15550009999",
      Body: body,
      MessageSid: messageSid ?? `SIM${crypto.randomUUID()}`,
    }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { replies: string[] };
}

async function seedModel(...turns: object[]): Promise<void> {
  for (const turn of turns) {
    await env.DB.prepare("INSERT INTO test_model_script (response) VALUES (?)").bind(JSON.stringify(turn)).run();
  }
}

function routineTurn(reply: string): object {
  return { reply, state: { answered: {}, urgency: "routine", done: false } };
}

describe("failure modes", () => {
  it("answers with the fallback and pings the owner when the model hangs (timeout)", async () => {
    const from = "+15553330001";
    // Both attempts hang; MODEL_TIMEOUT_MS=150 turns each into a fast failure.
    await env.DB.prepare("INSERT INTO test_model_script (response) VALUES ('__HANG__'), ('__HANG__')").run();

    const { replies } = await sms(from, "my shower drain is slow");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(`a team member from ${plumbing.business.name} will text you shortly`);

    const ping = await env.DB.prepare("SELECT body FROM notifications WHERE body LIKE '%Model failure%'").first<{
      body: string;
    }>();
    expect(ping?.body).toContain(from);
  });

  it("is idempotent on MessageSid: a Twilio retry does not reprocess the message", async () => {
    const from = "+15553330002";
    const sid = "SM_DUPLICATE_DELIVERY_TEST_00000001";
    await seedModel(routineTurn("What's the address?"));

    const first = await sms(from, "leaky faucet in the kitchen", sid);
    const retry = await sms(from, "leaky faucet in the kitchen", sid);

    expect(first.replies).toEqual(["What's the address?"]);
    expect(retry.replies).toEqual([]);

    const counts = await env.DB.prepare(
      "SELECT direction, COUNT(*) AS n FROM messages JOIN conversations ON conversations.id = messages.conversation_id WHERE caller_phone = ? GROUP BY direction"
    )
      .bind(from)
      .all<{ direction: string; n: number }>();
    const byDirection = Object.fromEntries(counts.results.map((r) => [r.direction, r.n]));
    expect(byDirection).toEqual({ inbound: 1, outbound: 1 });
  });

  it("handles concurrent messages from the same caller without loss (DO serialization)", async () => {
    const from = "+15553330003";
    await seedModel(routineTurn("Got it — what's the address?"), routineTurn("And when do you need this done?"));

    const [a, b] = await Promise.all([
      sms(from, "my toilet keeps running"),
      sms(from, "also the sink gurgles"),
    ]);

    // Both processed, each got exactly one reply, nothing dropped.
    expect(a.replies).toHaveLength(1);
    expect(b.replies).toHaveLength(1);

    const counts = await env.DB.prepare(
      "SELECT direction, COUNT(*) AS n FROM messages JOIN conversations ON conversations.id = messages.conversation_id WHERE caller_phone = ? GROUP BY direction"
    )
      .bind(from)
      .all<{ direction: string; n: number }>();
    const byDirection = Object.fromEntries(counts.results.map((r) => [r.direction, r.n]));
    expect(byDirection).toEqual({ inbound: 2, outbound: 2 });
  });

  it("replays every logged event without crashing", async () => {
    // The tests above logged real webhook events; add a voice-status event so
    // both replay paths are covered.
    await SELF.fetch("https://example.com/webhook/voice-status", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-channel": "simulator" },
      body: new URLSearchParams({ From: "+15553330004", CallSid: "CA_REPLAY_TEST", DialCallStatus: "no-answer" }),
    });

    const { results } = await env.DB.prepare("SELECT id, source, payload FROM events").all<{
      id: string;
      source: string;
      payload: string;
    }>();
    expect(results.length).toBeGreaterThan(0);

    for (const event of results) {
      const payload = JSON.parse(event.payload) as Record<string, string>;
      const path = event.source.includes("voice")
        ? "/webhook/voice-status"
        : event.source.includes("missed_call")
          ? "/trigger/missed-call"
          : "/webhook/sms";
      const res = await SELF.fetch(`https://example.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-channel": "simulator" },
        body: new URLSearchParams(payload),
      });
      expect(res.status, `replaying event ${event.id} (${event.source})`).toBe(200);
    }
  });
});
