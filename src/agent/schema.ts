// The structured turn the model must return. Zod-validated at the model
// boundary (CLAUDE.md style rule); everything except `reply` degrades
// gracefully because a usable reply with imperfect state beats a fallback.

import { z } from "zod";

export const AgentTurn = z.object({
  reply: z.string().min(1),
  state: z.object({
    // Models sometimes emit numbers/booleans/nulls as answer values; keep the
    // usable ones as strings, drop the rest.
    answered: z
      .record(z.string(), z.unknown())
      .default({})
      .transform((rec) => {
        const out: Record<string, string> = {};
        for (const [key, value] of Object.entries(rec)) {
          if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
          else if (typeof value === "number" || typeof value === "boolean") out[key] = String(value);
        }
        return out;
      }),
    service: z.string().optional().catch(undefined),
    summary: z.string().optional().catch(undefined),
    // The model's urgency read for this turn. The engine treats it as
    // raise-only: it can never lower a deterministic keyword hit (spec M3).
    urgency: z.enum(["routine", "urgent", "emergency"]).optional().catch(undefined),
    done: z.boolean().catch(false).default(false),
  }),
});
export type AgentTurn = z.infer<typeof AgentTurn>;

// Tolerates markdown fences and prose around the JSON object.
export function parseAgentTurn(raw: string): AgentTurn | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return AgentTurn.parse(JSON.parse(raw.slice(start, end + 1)));
  } catch {
    return null;
  }
}
