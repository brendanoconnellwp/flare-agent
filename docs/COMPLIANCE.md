# US SMS compliance playbook

The code in this repo is the easy half. Before a US carrier will deliver a single outbound text, the number you send from must be registered — and registration is where deployments stall, get rejected, and burn money. This document is the playbook: which number type to pick, how to fill in the forms so they pass review, and what to fix when they don't. Everything here was learned by getting rejected first.

## Choosing a number

The engine does not care which you pick. Swapping is one secret (`TWILIO_NUMBER`) plus `pnpm run wire-number` — no code changes.

| | Toll-free (833/844/855/…) | Local 10DLC (e.g. 619) |
|---|---|---|
| Registration | Toll-Free Verification: one form, **free** | A2P 10DLC: brand + campaign via TCR |
| Fees | none for verification | ~$4 brand (one-time), **$15 per campaign submission, non-refundable even when rejected**, ~$2/mo per campaign |
| Review | more lenient, predictable | opaque; automated + human vetting |
| Consumer perception | reads "corporate"; fine for direct replies | local presence; better answer/trust rates |
| Good for | demos, dev lines, budget deployments | production deployments for real local businesses |

**Rules of thumb:**

- **Demo or dev line → toll-free.** Free verification and no brand semantics to trip over.
- **Real client deployment → local 10DLC registered under the client's EIN** (Standard brand, Low-Volume tier). The business name on the brand then matches the business name in every message by construction, which avoids the single most common rejection.
- **Avoid Sole Proprietor 10DLC registration unless the messages will literally speak as that person.** A sole-prop brand carries an individual's legal name. If your campaign copy says "Hi, this is Acme Plumbing" while the brand says "Jane Smith", TCR rejects it — usually as "invalid campaign description" and "CTA could not be verified", without telling you the real reason. Either make the copy speak as the person ("Hi, this is Jane from Acme Plumbing"), or use a Standard brand with an EIN.

## Website prerequisites (both paths)

Reviewers visit your URLs. Three things must exist on the business's website **before** submitting anything:

**1. A page showing the phone number and consent language** (the "CTA page"). It can be unlinked from your navigation; what matters is that the URL you cite in the registration actually shows the number. Template:

> **Call or text us: (XXX) XXX-XXXX.** If we can't answer your call, we'll follow up by text message from this same number to help with your request. By calling, you consent to receive these conversational SMS replies. Message frequency varies by conversation; message & data rates may apply. Reply **STOP** at any time to stop receiving messages, or **HELP** for assistance. See our [Privacy Policy] and [Terms].

**2. Privacy policy** containing SMS disclosures. The two sentences reviewers scan for:

> No mobile information will be shared with third parties or affiliates for marketing or promotional purposes.
> Text messaging originator opt-in data and consent will not be shared with any third parties.

**3. Terms & conditions** naming the texting program, with all five required elements: program name and description, message frequency, "message and data rates may apply", support contact, and opt-out instructions (STOP/HELP).

## Path A: toll-free verification

Submit via Twilio Console (Phone Numbers → the number → "Verify this number") or the Toll-Free Verification API. Field guidance for this product:

- **Use case category:** Customer Care.
- **Use case summary:** "When a customer calls our business phone number and we cannot answer, we send an SMS follow-up to that caller to respond to their inquiry, collect details about their service request, and arrange a callback. All conversations are initiated by the customer's own call. No marketing."
- **Opt-in type:** Verbal (the consumer's phone call is the opt-in). Reference the CTA page URL as where the number and consent language are published.
- **Message sample:** use your config's `firstMessage` verbatim, with "Reply STOP to opt out." appended.
- **Volume:** pick the lowest realistic tier.

Typical turnaround is a few business days. Traffic is blocked (error 30032) until verified.

## Path B: local 10DLC (A2P) registration

Order of operations — do not skip ahead, each submission costs $15 whether it passes or not:

1. **Brand first, and make it match the story.** Standard brand under the business's EIN whenever possible. The `brand_name` on the registration is the identity every campaign is vetted against.
2. **CTA page live before submitting** (see above).
3. **Campaign registration.** Field guidance:
   - **Use case:** Low-Volume Mixed or Customer Care (Standard brand), or Sole Proprietor.
   - **Description:** who sends, to whom, triggered by what, frequency, STOP/HELP. Lead with the *registered brand name*: "This campaign sends conversational customer-care messages for [exact brand name]…"
   - **Samples:** real engine output — `firstMessage` (with STOP language), a qualification question, the escalation `callerAck`. Brand name must appear in sample #1 and match the registered brand.
   - **"How do end-users consent?"** — this is the field that fails most. Name the *exact CTA page URL*, state that opt-in is the customer's own phone call, and do not claim placements you can't prove (no "Google Business Profile and other listings" unless the reviewer can find the number there).
   - **Opt-in keywords / opt-in message:** leave blank. Opt-in is a phone call, not a texted keyword; claiming otherwise creates an inconsistency.
4. **Rejected campaigns cannot be edited into approval** — you delete and register a new one (another $15). So get the brand/copy alignment right the first time, and open a support ticket before a third attempt: support can see TCR vetting notes the console doesn't show.

## After approval

```sh
# Point the number's webhooks at the deployed Worker:
pnpm run wire-number +1XXXXXXXXXX https://your-worker.workers.dev

# Make sure the Worker sends from that number:
#   set TWILIO_NUMBER in .dev.vars, then upload with:
wrangler secret bulk   # (a JSON file; do NOT pipe secrets via stdin on Windows — newline corruption breaks signature validation)
```

## Account hygiene (learned the hard way)

- **Set Messaging Geo Permissions to US/Canada only** (Console → Messaging → Settings). The engine refuses non-NANP destinations too, but defense in depth is free.
- **Enable auto-recharge and a balance alert.** Registration fees hit as one-time charges; a surprise negative balance suspends the account, which drops inbound calls and SMS on the floor until you top up.
- Blocked messages still bill. A rejected/unregistered number attempting sends pays per attempt.

## Troubleshooting

| Error | Meaning | Fix |
|---|---|---|
| 30034 | 10DLC number has no approved campaign | finish Path B; traffic is hard-blocked until then |
| 30032 | toll-free number not verified | finish Path A |
| 30909 (CTA) | reviewer couldn't verify opt-in | CTA page missing/unnamed in the consent field, **or brand name ≠ business name in your copy** |
| 30886 (description) | description didn't hold up | usually the same brand/copy mismatch as 30909 |
| 11200 + HTTP 403 on your webhook | Twilio's request failed your signature validation | the deployed `TWILIO_AUTH_TOKEN` doesn't match — re-upload with `wrangler secret bulk`; check the webhook URL for typos with `pnpm run wire-number` |
