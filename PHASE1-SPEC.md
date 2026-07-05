# Phase 1 Build Spec — Missed-Call Emergency Agent

Execute milestones in order. Each milestone ends with a working, demonstrable state and its tests passing. Do not start a milestone until the previous one's acceptance check passes. Read CLAUDE.md first; its hard rules override anything here.

## M0 — Scaffold (half a session)

- pnpm project, TypeScript strict, Hono, wrangler.jsonc with bindings declared up front: DO (`CONVERSATION`), D1 (`DB`), vars (`MODEL_PROVIDER`, `MODEL_ID`, `VERTICAL`), secrets documented in `.dev.vars.example` (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_NUMBER`, `AI_GATEWAY_*`).
- `src/config/schema.ts` (already drafted — use as-is), config loader that reads `verticals/${env.VERTICAL}.json` at build time and validates with Zod. Invalid config = failed deploy, not runtime surprise.
- `db/schema.sql` applied via `pnpm setup` script (creates D1 if missing, runs migrations, prompts for secrets).
- **Accept:** `pnpm dev` boots; `GET /health` returns config business name + trade.

## M1 — Simulator + engine echo (the dev loop exists)

- `POST /webhook/sms` accepts Twilio-shaped form-encoded payloads (`From`, `Body`, `To`, `MessageSid`). Normalizes to `{ from, text, channel }` and hands to the ConversationDO. No Twilio SDK anywhere.
- ConversationDO: keyed by caller phone. Stores history, returns a canned reply for now. Persists conversation + messages to D1.
- `pnpm chat`: CLI (readline) that generates fake payloads, POSTs to local dev, prints replies. Supports `--from +1555...` to simulate different callers and `--replay <event-id>` reserved for later.
- STOP/HELP handling in the engine: STOP → persist to opt_outs, confirm once, never message again (checked before EVERY outbound). HELP → static help text. This lands before the model does — compliance is not a later feature.
- **Accept:** full echo conversation in terminal; rows appear in D1; STOP works and is honored on subsequent contact.

## M2 — Config-driven agent conversation

- System prompt assembled from config: business identity, tone, services taxonomy, qualification questions (with purposes), policies (never quote prices unless allowed, max message count). Prompt lives in `src/agent/prompt.ts` as a pure function of (config, history) — snapshot-testable.
- Model call via AI Gateway; provider adapter interface with Workers AI implementation first. Model returns structured JSON (Zod-validated): `{ reply, state: { answered: {...}, service?, done? } }`. On invalid JSON: one retry, then safe fallback reply + owner ping.
- Conversation completes when required qualification fields are answered → write lead to D1 → send owner notification (notification tool logs to console in dev; Twilio adapter comes in M4).
- `firstMessage` from config is sent instantly on missed-call trigger — before any model call. Speed to first text is deterministic.
- **Accept:** in `pnpm chat`, a routine "water heater making noise" conversation asks the config's questions one at a time, then produces a lead row with a sensible summary.

## M3 — Urgency triage + escalation (the actual product)

- Deterministic layer FIRST: on every inbound message, lowercase substring match against all `emergency.scenarios[].signals`. A hit sets urgency immediately — no model dependency.
- Model layer SECOND: the model also classifies urgency each turn; it can raise urgency (caller described an emergency in words the signals missed) but can never lower a deterministic hit.
- `lifeSafety: true` scenarios: respond with the engine's hardcoded language (leave the area, call 911 / your utility), then escalate. The model does not compose this message.
- Escalation: send `ownerTemplate` (interpolated) to `ownerNotify.phone`, send `callerAck` to caller, mark conversation escalated. After-hours behavior per config.
- **Accept:** `pnpm test` covers: "water everywhere" escalates on the deterministic path with the model mocked to FAIL; "I smell gas" produces the hardcoded life-safety response; a routine job does not escalate; model-detected emergency ("my ceiling is raining") escalates via the model path.

## M4 — Twilio adapter (thin)

- Outbound send via Twilio REST (fetch, no heavy SDK). Webhook signature validation on `/webhook/sms`. Missed-call trigger: `/webhook/voice-status` handling forwarded-call no-answer → fires `firstMessage`.
- Raw payload logging to `events` table. `pnpm chat --replay <id>` replays a stored event locally.
- Quiet-hours hold for non-emergency outbound (emergencies always send).
- **Accept:** Twilio-to-Twilio harness (second number, scripted) completes a full conversation on real carrier round-trips.

## M5 — Persona tests + hardening

- `pnpm test:personas`: LLM-played callers — panicked-burst-pipe, vague-one-worder, tire-kicker, answers-everything-in-first-message, mid-conversation-emergency ("actually now it's spraying"), STOP-mid-flow. Transcripts to `test-output/` with an auto-grade pass (did it escalate when it should? capture the lead? respect max messages?).
- Failure modes: model timeout → fallback reply + owner ping; duplicate webhook delivery (Twilio retries) → idempotent on MessageSid; concurrent messages → DO serialization handles it, verify.
- **Accept:** all personas produce correct terminal states; replaying any logged production event doesn't crash.

## Definition of done for Phase 1

A real business's forwarded line is live on this deployment, and at least one real missed call has produced either an escalation or a captured lead. Code merged ≠ done.

## Explicitly out of scope for Phase 1

Voice conversations, scheduling/calendar tools, review responses, multi-tenant anything, admin UI, payment. Resist.
