# Missed-Call Emergency Agent

SMS agent for emergency-driven local service businesses (plumbing, electrical, HVAC, locksmith, and similar trades). When the business misses a call, the agent texts back within seconds, triages urgency, escalates true emergencies to a human immediately, and qualifies + captures non-emergency leads.

Runs on Cloudflare Workers (free or $5/mo plan) + a Twilio number. One business = one deployment; the trade is configuration (`verticals/*.json`), never code.

## Quick start (local)

```sh
pnpm install
pnpm run setup    # validates configs, applies db/schema.sql to the local D1
pnpm dev          # wrangler dev on http://localhost:8787
pnpm chat         # interactive SMS simulator against local dev (second terminal)
```

`GET /health` returns the loaded business name + trade — if it answers, config and bindings are wired.

## Deploy

```sh
wrangler login
pnpm run setup --remote   # creates the D1 database, patches its id into wrangler.jsonc,
                          # applies the schema remotely, prompts for Twilio secrets
pnpm run deploy           # validates configs, then wrangler deploy
```

## Wire up Twilio

1. Buy a Twilio number and set the three secrets (`pnpm run setup --remote` prompts, or `wrangler secret put TWILIO_ACCOUNT_SID` etc.).
2. In the Twilio console, point the number at your deployed Worker:
   - **Voice → A call comes in**: `https://<your-worker>/twiml/voice` (HTTP POST). This rings the owner's phone (`business.ownerNotify.phone` from config) for 15 seconds; a missed call fires the instant text-back.
   - **Messaging → A message comes in**: `https://<your-worker>/webhook/sms` (HTTP POST).
3. Have the business set conditional call forwarding (busy/no-answer) from their real line to the Twilio number — or publish the Twilio number directly.

All Twilio webhooks are signature-validated (`X-Twilio-Signature`); requests that don't verify get a 403. Non-emergency outbound is held during config `quietHours` and delivered when the window ends; emergencies, STOP confirmations, HELP responses, and owner alerts always send immediately.

Replay any logged production event locally: `pnpm chat --replay <event-id> --remote` (event ids live in the `events` table).

## Configure your business

1. Copy a vertical config, e.g. `verticals/plumbing.json`, or write a new one for your trade.
2. Edit business name, hours, owner phone, emergency scenarios/signals, qualification questions.
3. Point `VERTICAL` in `wrangler.jsonc` at it. Invalid configs fail `pnpm run deploy` with line-level errors.

The schema is `src/config/schema.ts` — every business-specific knob lives there, not in engine code.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | wrangler dev |
| `pnpm chat` | interactive simulator against local dev (`--from +1555...`, `--missed-call`, `--replay <event-id>`) |
| `pnpm test` | vitest flow tests: triage, escalation, compliance, failure modes (model mocked) |
| `pnpm test:personas` | LLM-played callers against the real engine + model; transcripts + auto-grades in `test-output/` |
| `pnpm run setup` | local D1 schema + `.dev.vars` scaffold (`--remote` for cloud setup + secrets) |
| `pnpm validate:config` | validate all `verticals/*.json` |
| `pnpm typecheck` | typecheck worker + scripts |
| `pnpm run deploy` | validate configs, then deploy |
