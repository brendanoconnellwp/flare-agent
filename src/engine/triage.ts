// Urgency triage. The deterministic layer: lowercase substring match against
// config emergency signals. Hard rule 6 — a keyword hit escalates even if the
// model call fails or classifies differently. The model refines; keywords
// guarantee.

import type { VerticalConfig } from "../config/schema";

export type EmergencyScenario = VerticalConfig["emergency"]["scenarios"][number];
export type Urgency = "routine" | "urgent" | "emergency";

// Life-safety scenarios are checked first: when a message matches both a
// life-safety and an ordinary scenario ("gas smell and water everywhere"),
// safety wins (hard rule 4).
export function matchEmergencySignals(config: VerticalConfig, text: string): EmergencyScenario | null {
  const t = text.toLowerCase();
  const scenarios = [...config.emergency.scenarios].sort(
    (a, b) => Number(b.lifeSafety) - Number(a.lifeSafety)
  );
  for (const scenario of scenarios) {
    if (scenario.signals.some((signal) => t.includes(signal.toLowerCase()))) return scenario;
  }
  return null;
}

// Hard rule 4: engine-owned language for life-safety situations (gas, fire,
// CO, sparking). Never composed by the model, never overridable by config.
export const LIFE_SAFETY_RESPONSE =
  "This could be dangerous. Please leave the area now and call 911 — or your utility's emergency line — from a safe distance. " +
  "Don't flip switches or use anything with a flame or spark. Our on-call team has been alerted and will call you right away.";

// Model classifications can raise urgency but never lower it (spec M3).
const RANK: Record<Urgency, number> = { routine: 0, urgent: 1, emergency: 2 };

export function raiseUrgency(current: Urgency | undefined, next: Urgency | undefined): Urgency | undefined {
  if (!next) return current;
  if (!current) return next;
  return RANK[next] > RANK[current] ? next : current;
}
