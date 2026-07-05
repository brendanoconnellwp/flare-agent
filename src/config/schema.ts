// src/config/schema.ts
// Vertical config schema v1 — the contract between the engine and any trade.
// Rule: if onboarding a business requires editing engine code, the missing
// knob gets added HERE instead.

import { z } from "zod";

const Hours = z.object({
  // "HH:MM" 24h local time; null = closed that day
  timezone: z.string(), // IANA, e.g. "America/Los_Angeles"
  days: z.record(
    z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
    z.object({ open: z.string(), close: z.string() }).nullable()
  ),
});

const EmergencyScenario = z.object({
  id: z.string(), // "burst_pipe"
  label: z.string(), // shown to the owner in notifications
  // Deterministic triggers: substring/keyword match on caller text.
  // These escalate even if the model call fails. Lowercase.
  signals: z.array(z.string()).min(1),
  // Owner-approved caller guidance ONLY. The engine will never generate
  // safety advice beyond this text. Omit for scenarios where any advice
  // is risky (gas, electrical) — the engine has hardcoded 911/utility
  // language for those.
  callerGuidance: z.string().optional(),
  // If true, engine uses its hardcoded "leave the area, call 911/utility"
  // response and escalates immediately (gas leak, fire, CO, sparking).
  lifeSafety: z.boolean().default(false),
});

const QualificationQuestion = z.object({
  id: z.string(), // "location", "issue_detail", "timeline"
  ask: z.string(), // natural phrasing the agent should use
  purpose: z.string(), // why we ask — goes into the system prompt
  required: z.boolean().default(true),
});

export const VerticalConfig = z.object({
  version: z.literal(1),

  business: z.object({
    name: z.string(),
    trade: z.string(), // "plumbing", "electrical", ...
    serviceArea: z.string(), // human description: "San Diego County"
    ownerNotify: z.object({
      phone: z.string(), // E.164 — where escalations + lead summaries go
      alsoEmail: z.string().email().optional(),
    }),
    hours: Hours,
  }),

  services: z.array(z.string()).min(1), // taxonomy for classification

  emergency: z.object({
    scenarios: z.array(EmergencyScenario).min(1),
    // What "escalate" means for this business:
    escalation: z.object({
      method: z.enum(["sms_owner", "sms_owner_then_call"]),
      // Message template for the owner; {summary} {phone} {scenario} interpolated
      ownerTemplate: z.string(),
      // What we tell the caller after escalating
      callerAck: z.string(),
    }),
    afterHours: z.enum(["escalate_anyway", "escalate_and_set_expectation"]),
  }),

  qualification: z.array(QualificationQuestion).min(1),

  policies: z.object({
    quoting: z.enum(["never", "range_from_config"]),
    priceRanges: z.record(z.string(), z.string()).optional(), // service -> "typically $X–$Y"
    maxAgentMessages: z.number().int().min(3).max(20).default(10),
    // Local-time window outside which non-emergency outbound is held (TCPA hygiene)
    quietHours: z.object({ start: z.string(), end: z.string() }).default({ start: "21:00", end: "08:00" }),
  }),

  voice: z.object({
    tone: z.string(), // "friendly, brief, no fluff — texts like a competent dispatcher"
    firstMessage: z.string(), // the instant text-back; {businessName} interpolated
    signoff: z.string().optional(),
  }),
});

export type VerticalConfig = z.infer<typeof VerticalConfig>;
