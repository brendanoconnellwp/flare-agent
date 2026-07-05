// M4 adapter tests: signature validation (Twilio's documented test vector +
// a live round-trip through the webhook) and the voice-status → firstMessage
// missed-call trigger.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { validateTwilioSignature } from "../src/channels/twilio";
import plumbing from "../verticals/plumbing.json";

// Matches the fake token pinned in vitest.config.ts.
const AUTH_TOKEN = "test-auth-token-0123456789abcdef";

async function computeSignature(authToken: string, url: string, params: Record<string, string>): Promise<string> {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

describe("Twilio signature validation", () => {
  // The worked example from https://www.twilio.com/docs/usage/security
  it("accepts Twilio's documented example signature", async () => {
    const url = "https://mycompany.com/myapp.php?foo=1&bar=2";
    const params = {
      CallSid: "CA1234567890ABCDE",
      Caller: "+14158675310",
      Digits: "1234",
      From: "+14158675310",
      To: "+18005551212",
    };
    const ok = await validateTwilioSignature("12345", url, params, "GvWf1cFY/Q7PnoempGyD5oXAezc=");
    expect(ok).toBe(true);
  });

  it("rejects a tampered payload", async () => {
    const url = "https://example.com/webhook/sms";
    const params = { From: "+15551234567", Body: "hello" };
    const signature = await computeSignature(AUTH_TOKEN, url, params);
    expect(await validateTwilioSignature(AUTH_TOKEN, url, { ...params, Body: "attacker" }, signature)).toBe(false);
  });

  it("rejects an unsigned twilio-channel webhook (403)", async () => {
    const res = await SELF.fetch("https://example.com/webhook/sms", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, // no x-channel → twilio
      body: new URLSearchParams({
        From: "+15552220001",
        To: "+15550009999",
        Body: "hello",
        MessageSid: "SM00000000000000000000000000000001",
      }),
    });
    expect(res.status).toBe(403);
  });

  it("accepts a correctly signed twilio-channel webhook and answers TwiML", async () => {
    const url = "https://example.com/webhook/sms";
    const params = {
      From: "+15552220002",
      To: "+15550009999",
      // A deterministic-path emergency so no model script is needed.
      Body: "water everywhere in the kitchen",
      MessageSid: "SM00000000000000000000000000000002",
    };
    const res = await SELF.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": await computeSignature(AUTH_TOKEN, url, params),
      },
      body: new URLSearchParams(params),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/xml");
    const twiml = await res.text();
    expect(twiml).toContain("<Message>");
    // TwiML XML-escapes the body ("I've" → "I&apos;ve").
    expect(twiml).toContain(plumbing.emergency.escalation.callerAck.replaceAll("'", "&apos;"));
  });
});

describe("voice-status missed-call trigger", () => {
  async function voiceStatus(from: string, fields: Record<string, string>) {
    const res = await SELF.fetch("https://example.com/webhook/voice-status", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-channel": "simulator" },
      body: new URLSearchParams({ From: from, CallSid: `CA${crypto.randomUUID()}`, ...fields }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { replies: string[] };
  }

  it("fires the config firstMessage on a no-answer forwarded call", async () => {
    const from = "+15552220003";
    const { replies } = await voiceStatus(from, { DialCallStatus: "no-answer" });

    const expected = plumbing.voice.firstMessage.replace("{businessName}", plumbing.business.name);
    expect(replies).toEqual([expected]);

    // Recorded as an outbound message on a real conversation.
    const row = await env.DB.prepare(
      "SELECT direction, body FROM messages JOIN conversations ON conversations.id = messages.conversation_id WHERE caller_phone = ?"
    )
      .bind(from)
      .first<{ direction: string; body: string }>();
    expect(row).toMatchObject({ direction: "outbound", body: expected });
  });

  it("does not text back on an answered call", async () => {
    const { replies } = await voiceStatus("+15552220004", { DialCallStatus: "completed", CallStatus: "completed" });
    expect(replies).toEqual([]);
  });

  it("sends only one text-back for rapid duplicate callbacks", async () => {
    const from = "+15552220005";
    const first = await voiceStatus(from, { DialCallStatus: "no-answer" });
    const second = await voiceStatus(from, { DialCallStatus: "busy" });
    expect(first.replies).toHaveLength(1);
    expect(second.replies).toEqual([]);
  });

  it("serves forwarding TwiML that dials the owner", async () => {
    const res = await SELF.fetch("https://example.com/twiml/voice", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-channel": "simulator" },
      body: new URLSearchParams({ From: "+15552220006", CallSid: "CA123" }),
    });
    expect(res.status).toBe(200);
    const twiml = await res.text();
    // The url attribute screens for a human answer — voicemail answering the
    // forwarded leg must not count as a connected call.
    expect(twiml).toContain(`<Number url="/twiml/voice-screen">${plumbing.business.ownerNotify.phone}</Number>`);
    expect(twiml).toContain('action="/webhook/voice-status"');
  });

  it("screens the forwarded leg: gather for a human, hang up on silence, bridge on keypress", async () => {
    const screen = await SELF.fetch("https://example.com/twiml/voice-screen", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-channel": "simulator" },
      body: new URLSearchParams({ CallSid: "CA123" }),
    });
    expect(screen.status).toBe(200);
    const twiml = await screen.text();
    expect(twiml).toContain('<Gather action="/twiml/voice-screen-accept"');
    expect(twiml).toContain("<Hangup/>"); // no keypress → leg dies → missed call

    const accept = await SELF.fetch("https://example.com/twiml/voice-screen-accept", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-channel": "simulator" },
      body: new URLSearchParams({ CallSid: "CA123", Digits: "5" }),
    });
    expect(accept.status).toBe(200);
    expect(await accept.text()).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });
});
