// Twilio channel adapter: Twilio-shaped form payloads in, TwiML out.
// Deliberately no Twilio SDK — the wire format is four form fields and a
// small XML document.

import { z } from "zod";
import { isNanpPhone } from "../lib/phone";
import type { Channel, InboundSms } from "./types";

// Body cap: a real SMS tops out around 1600 chars; anything larger is not a
// phone and gets a 400 before it reaches the engine or the model.
export const TwilioSmsPayload = z.object({
  From: z.string().min(1).max(32),
  To: z.string().min(1).max(32),
  Body: z.string().max(2048),
  MessageSid: z.string().min(1).max(64),
});
export type TwilioSmsPayload = z.infer<typeof TwilioSmsPayload>;

export function toInbound(payload: TwilioSmsPayload, channel: Channel): InboundSms {
  return {
    from: payload.From.trim(),
    to: payload.To.trim(),
    text: payload.Body,
    messageSid: payload.MessageSid,
    channel,
  };
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// An empty <Response/> is valid TwiML and sends nothing — used when the
// caller is opted out.
export function renderTwiml(replies: string[]): string {
  const messages = replies.map((r) => `<Message>${escapeXml(r)}</Message>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${messages}</Response>`;
}

// Voice TwiML: ring the owner's phone; if nobody answers within the timeout,
// Twilio POSTs the outcome to /webhook/voice-status, which fires the
// missed-call text-back.
//
// The url attribute screens the answered leg for a human (see
// renderVoiceScreenTwiml): without it, the owner's VOICEMAIL answering
// counts as "completed" and silently defeats missed-call detection.
export function renderVoiceForwardTwiml(ownerPhone: string, timeoutSeconds = 15): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Dial timeout="${timeoutSeconds}" action="/webhook/voice-status">` +
    `<Number url="/twiml/voice-screen">${escapeXml(ownerPhone)}</Number>` +
    `</Dial></Response>`
  );
}

// Whisper played to whoever answered the forwarded leg. A human presses a
// key and the call bridges; a voicemail can't, so the leg hangs up and the
// call correctly counts as missed.
export function renderVoiceScreenTwiml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Response>` +
    `<Gather action="/twiml/voice-screen-accept" numDigits="1" timeout="4">` +
    `<Say>Incoming call from your business line. Press any key to accept.</Say>` +
    `</Gather><Hangup/></Response>`
  );
}

// Gather action target: any digit means a human accepted; an empty response
// lets the call bridge.
export function renderVoiceScreenAcceptTwiml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
}

// Outbound SMS via the Twilio REST API — plain fetch, no SDK (the wire
// format is one form-encoded POST).
export async function sendSms(env: Env, to: string, body: string): Promise<void> {
  // Toll-fraud backstop: never REST-send outside NANP, regardless of what a
  // webhook claimed the caller was. Routes filter first; this catches any
  // future code path that forgets to.
  if (!isNanpPhone(to)) {
    throw new Error(`refusing to send SMS to non-NANP number`);
  }
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: env.TWILIO_NUMBER, Body: body }),
  });
  if (!res.ok) {
    throw new Error(`Twilio send to ${to} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

// X-Twilio-Signature validation: base64(HMAC-SHA1(url + sorted(key+value)
// concatenation, auth token)). https://www.twilio.com/docs/usage/security
export async function validateTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string
): Promise<boolean> {
  const data = url + Object.keys(params).sort().map((key) => key + params[key]).join("");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(authToken), { name: "HMAC", hash: "SHA-1" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return constantTimeEqual(expected, signature);
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i]! ^ bb[i]!;
  return diff === 0;
}
