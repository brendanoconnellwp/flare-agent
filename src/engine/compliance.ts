// STOP/HELP keyword handling. Hard rule: compliance is code, not config —
// nothing in verticals/*.json can weaken or disable this.
//
// Keyword sets mirror Twilio's standard opt-out keywords: the whole message,
// trimmed and lowercased, must be the keyword (matching carrier behavior;
// "please stop calling" is a sentence for the agent, not an opt-out).

export type ComplianceKind = "stop" | "help";

const STOP_WORDS = new Set(["stop", "stopall", "unsubscribe", "cancel", "end", "quit"]);
const HELP_WORDS = new Set(["help", "info"]);

export function complianceKeyword(text: string): ComplianceKind | null {
  const t = text.trim().toLowerCase();
  if (STOP_WORDS.has(t)) return "stop";
  if (HELP_WORDS.has(t)) return "help";
  return null;
}

export function stopConfirmation(businessName: string): string {
  return `${businessName}: You have been unsubscribed and will receive no further messages from this number.`;
}

export function helpText(businessName: string, trade: string, serviceArea: string): string {
  return `${businessName}: This number takes ${trade} service requests by text for ${serviceArea}. Tell us what you need and we'll get you helped. Reply STOP to opt out. Msg&data rates may apply.`;
}
