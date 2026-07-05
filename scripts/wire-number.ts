// Points a Twilio phone number at a deployed Worker: voice webhook to
// /twiml/voice, SMS webhook to /webhook/sms, both POST. Setup steps get
// scripted, not remembered (CLAUDE.md) — and manual console entry is how
// URLs get typo'd (it happened; the SMS webhook silently 404'd).
//
//   pnpm run wire-number +18885551234 https://your-worker.workers.dev
//
// Works for any number on the account: local 10DLC or toll-free. Swapping
// the deployment to a different number is this script plus updating the
// TWILIO_NUMBER secret (`wrangler secret bulk`). See docs/COMPLIANCE.md.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const [phone, workerUrl] = process.argv.slice(2);

if (!phone || !/^\+1\d{10}$/.test(phone) || !workerUrl || !/^https:\/\//.test(workerUrl)) {
  console.error("Usage: pnpm run wire-number <+1XXXXXXXXXX> <https://your-worker.workers.dev>");
  process.exit(1);
}
const base = workerUrl.replace(/\/$/, "");

// Credentials from .dev.vars (same values the Worker uses).
const vars: Record<string, string> = {};
for (const line of readFileSync(join(import.meta.dirname, "..", ".dev.vars"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)\s*=\s*"(.*)"$/);
  if (m) vars[m[1]!] = m[2]!;
}
const sid = vars.TWILIO_ACCOUNT_SID;
const token = vars.TWILIO_AUTH_TOKEN;
if (!sid || !token) {
  console.error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing from .dev.vars");
  process.exit(1);
}
const auth = `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`;

async function twilio(path: string, body?: URLSearchParams): Promise<any> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: auth, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body,
  });
  if (!res.ok) throw new Error(`Twilio ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const list = await twilio(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}`);
const number = list.incoming_phone_numbers?.[0];
if (!number) {
  console.error(`${phone} is not a number on this Twilio account.`);
  process.exit(1);
}

console.log(`${phone} (${number.sid})`);
console.log(`  voice: ${number.voice_url || "(unset)"} -> ${base}/twiml/voice`);
console.log(`  sms:   ${number.sms_url || "(unset)"} -> ${base}/webhook/sms`);

const updated = await twilio(
  `/IncomingPhoneNumbers/${number.sid}.json`,
  new URLSearchParams({
    VoiceUrl: `${base}/twiml/voice`,
    VoiceMethod: "POST",
    SmsUrl: `${base}/webhook/sms`,
    SmsMethod: "POST",
  })
);

console.log(`\nWired. voice=${updated.voice_url} sms=${updated.sms_url}`);
console.log(`Reminder: TWILIO_NUMBER secret must match — update .dev.vars and run 'wrangler secret bulk' if you changed numbers.`);
