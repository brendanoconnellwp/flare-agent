// The engine's channel-agnostic message shape. Adapters (twilio.ts,
// simulator.ts) translate to/from this; the engine never sees wire formats.

export type Channel = "twilio" | "simulator";

export interface InboundSms {
  from: string; // caller, E.164
  to: string; // the business number
  text: string;
  messageSid: string;
  channel: Channel;
}
