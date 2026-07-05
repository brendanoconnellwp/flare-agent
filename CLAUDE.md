# Missed-Call Emergency Agent

An SMS agent for emergency-driven local service businesses (plumbing, electrical, HVAC, locksmith, garage door, water damage, towing). When the business misses a call, the agent texts back within seconds, triages urgency, escalates true emergencies to a human immediately, and qualifies + captures non-emergency leads.

Runs on Cloudflare Workers. Designed to be publicly cloneable and deployable on the free or $5/mo Workers plan plus a Twilio number.

## Core product thesis

The product is **urgency triage**, not chat. Every design decision optimizes for: (1) speed to first text, (2) correct emergency classification, (3) fast human handoff on emergencies, (4) clean lead capture otherwise. The trade (plumber vs. electrician) is configuration, never code.

## Architecture

- **Workers + Hono** for HTTP. Routes are thin: parse, normalize, delegate.
- **One Durable Object per conversation** (keyed by caller phone number). The DO owns conversation state, history, and the agent loop.
- **D1** for durable records: conversations, messages, leads. The DO is the hot path; D1 is the system of record.
- **AI Gateway** in front of all model calls. Default provider: Workers AI. Provider must be swappable via env var (`MODEL_PROVIDER`, `MODEL_ID`).
- **Channel adapters** (`src/channels/`): Twilio is one adapter; the simulator is another. The engine never imports Twilio types.
- **Single-tenant per deployment.** One business = one Worker + one D1 + one config. No multi-tenancy.

## Hard rules

1. **Config, not code.** Anything business- or trade-specific lives in `verticals/*.json` (validated by `src/config/schema.ts`) or in Wrangler secrets. If onboarding a new business requires editing a `.ts` file, promote that field into the schema instead.
2. **Public path = production path.** The repo must deploy from a fresh clone + README with no undocumented steps. Setup steps get scripted (`pnpm setup`), not remembered.
3. **Hardcode at one, parameterize at two, abstract at three.** Do not build abstractions for agents or channels that don't exist yet.
4. **Safety over helpfulness.** The agent NEVER gives DIY repair instructions for gas, electrical, or structural issues. Suspected gas leak, fire, sparking, or carbon monoxide → tell the caller to leave the area and call 911 / their utility, then escalate to the owner. The only self-help guidance permitted is what the config's `emergency.callerGuidance` explicitly contains (owner-approved text, e.g. "shut off the main water valve").
5. **Compliance is code, not config.** STOP/HELP keyword handling, opt-out persistence, and quiet-hours behavior are implemented in the engine and cannot be disabled by config.
6. **Escalation must not depend on the model.** Emergency keyword hits (from config `signals`) trigger escalation deterministically even if the model call fails or classifies differently. The model refines; keywords guarantee.
7. **Never quote prices** unless config `policies.quoting` allows a range, and never invent availability.
8. **Log every real inbound webhook payload** (D1 `events` table) so production conversations are replayable as local fixtures.

## Testing layers (in order of preference)

1. `pnpm chat` — CLI simulator that POSTs fake Twilio payloads to the local Worker. This is the primary dev loop.
2. `pnpm test` — vitest (`@cloudflare/vitest-pool-workers`): scripted conversations asserting triage, escalation, lead capture, STOP handling. Model calls mocked for flow tests.
3. `pnpm test:personas` — LLM-played callers (panicked, vague, tire-kicker, out-of-order answerer) run against the real engine; transcripts written to `test-output/` for review.
4. Twilio-to-Twilio harness, then a real handset — smoke tests only.

## Commands

- `pnpm dev` — wrangler dev
- `pnpm chat` — interactive simulator against local dev
- `pnpm test` / `pnpm test:personas`
- `pnpm setup` — create D1, run migrations, prompt for secrets
- `pnpm deploy` — wrangler deploy

## Style

TypeScript strict. Zod at every boundary (webhooks, config, model JSON output). Small files, no barrel exports. Comments explain *why*, not *what*.
