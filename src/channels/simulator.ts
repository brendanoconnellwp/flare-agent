// Simulator channel adapter: same Twilio-shaped payload in (so the webhook
// path is exercised end to end), plain JSON out for the chat CLI.

export interface SimulatorReply {
  replies: string[];
  // Set when quiet hours held the outbound; epoch ms of scheduled delivery.
  heldUntil?: number;
}

export function renderSimulatorReply(replies: string[], heldUntil?: number): SimulatorReply {
  return heldUntil === undefined ? { replies } : { replies, heldUntil };
}
