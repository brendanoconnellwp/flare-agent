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

1. Pick a number type — **read [docs/COMPLIANCE.md](docs/COMPLIANCE.md) first**: US carriers block business SMS until the number is registered, and the wrong registration path costs real money. TL;DR: toll-free for demos, local 10DLC under the client's EIN for production.
2. Buy the number and set the three secrets (`pnpm run setup --remote` prompts, or `wrangler secret bulk`).
3. Point the number at your deployed Worker:
   ```sh
   pnpm run wire-number +1XXXXXXXXXX https://<your-worker>.workers.dev
   ```
   This sets Voice → `/twiml/voice` (rings the owner from config for 15s; a missed call fires the instant text-back) and Messaging → `/webhook/sms`. Swapping to a different number later is this same command plus updating the `TWILIO_NUMBER` secret.
4. Have the business set conditional call forwarding (busy/no-answer) from their real line to the Twilio number — or publish the Twilio number directly.

All Twilio webhooks are signature-validated (`X-Twilio-Signature`); requests that don't verify get a 403. Non-emergency outbound is held during config `quietHours` and delivered when the window ends; emergencies, STOP confirmations, HELP responses, and owner alerts always send immediately.

Replay any logged production event locally: `pnpm chat --replay <event-id> --remote` (event ids live in the `events` table).

## Owner dashboard (optional)

A read-only dashboard at `/dashboard` shows leads, conversations (with full transcripts), and owner alerts. It is **disabled unless a `DASHBOARD_TOKEN` secret exists** — set one (`wrangler secret put DASHBOARD_TOKEN`, any long random string), then open:

```
https://<your-worker>/dashboard?token=<DASHBOARD_TOKEN>
```

That signs the browser in with an HttpOnly cookie; bookmark the clean `/dashboard` URL after. Auth uses constant-time comparison, all caller/model text is HTML-escaped, and responses are `no-store`.

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
| `pnpm run wire-number` | point a Twilio number's voice/SMS webhooks at the deployed Worker |
| `pnpm typecheck` | typecheck worker + scripts |
| `pnpm run deploy` | validate configs, then deploy |
