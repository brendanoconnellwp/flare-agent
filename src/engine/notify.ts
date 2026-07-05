// Owner notifications (escalations, lead alerts, failure pings). Every
// notification is persisted to D1 first (audit trail — did we actually try
// to reach the owner?), then delivered via Twilio SMS when credentials are
// configured. Owner alerts are never quiet-hours held: the owner opted into
// being woken up — that is the product.

import { sendSms } from "../channels/twilio";
import type { VerticalConfig } from "../config/schema";
import { ulid } from "../lib/ulid";

export async function notifyOwner(env: Env, config: VerticalConfig, text: string): Promise<void> {
  const to = config.business.ownerNotify.phone;
  console.log(JSON.stringify({ event: "owner_notification", to, text }));
  await env.DB.prepare("INSERT INTO notifications (id, to_phone, body, created_at) VALUES (?, ?, ?, ?)")
    .bind(ulid(), to, text, Date.now())
    .run();

  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_NUMBER) {
    try {
      await sendSms(env, to, text);
    } catch (err) {
      // A failed owner alert must never crash the caller-facing flow; the D1
      // row above is the record that we owe the owner a message.
      console.error(JSON.stringify({ event: "owner_notify_send_failed", error: String(err) }));
    }
  }
}
