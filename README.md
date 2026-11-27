# Reply agent template

A starting point for a reply agent for any cold-email setup. It holds no client data and no keys. See [REPLY-AGENT-GUIDE.md](REPLY-AGENT-GUIDE.md) for a plain-language overview.

An inbound-reply agent for cold email. Works with Instantly (API v2), EmailBison and PlusVibe, and runs on Trigger.dev.

What it does for a client, once configured:
1. Scans the client's inbox every minute for new positive replies.
2. A model PICKS an action (plain yes, one-topic question, a time, or hand to a person). It never writes to a lead. Code fills approved copy.
3. Replies in-thread from the same inbox. With HubSpot it offers up to 3 live call times and books the one they pick. With any other calendar it sends your booking link.
4. Posts every decision to Slack as a card (with a link to the Bison thread when sending through Bison). A person can answer from the Slack thread.
5. Nudges a lead who said a plain yes and went quiet, twice (24h, then 48h), never on weekends. Stands down the moment anyone replies by hand.
6. Handles referrals, "call booked through the link", and (optionally) puts positives into HubSpot.
7. For anything the ready-made answers don't cover, writes a reply from the client's knowledge base, checks it with a second model call and fixed rules, and hands to a person if it fails.

It starts in shadow mode (`MODE=shadow`): it posts what it WOULD send and sends nothing.

## Start a new client

Open this folder in Claude Code and say: **"Follow CLAUDE.md and set up a reply agent for me."**

It interviews you first (who you write to, what you send, which calendar and CRM you use, what must go to a human), writes a Fit Report saying what the template does and does not cover for you, and only builds after you approve it. Have your email scripts, campaign names and two or three real replies you like to hand.

```bash
npm install
npm test                   # typecheck, the copy render, and the Instantly adapter check
npm run test:render        # prints every reply the agent can send, for sign-off
npm run deploy             # regenerates src/knowledge.ts, then deploys to Trigger.dev
```

`examples/northbridge-recruiting/` is a filled-in **fictional** example (a solo recruiter) showing the shape of `client.ts` and `knowledge.md`. Nothing in it is real.

## Layout

| Path | What |
|---|---|
| `src/client.ts` | Everything client-specific: name, owner, offers, approved copy, banned words |
| `knowledge.md` | The facts the free-text writer may use. Source of truth. `src/knowledge.ts` is generated from it |
| `src/prompt.ts` | Classifier prompts, copy templates, parsing. Client-neutral |
| `src/replies.ts` | Scan, process, send, nudge, Slack, booking tasks. Client-neutral |
| `src/compose.ts` | Free-text writer + guard |
| `src/instantly.ts`, `src/plusvibe.ts` | Sending-platform adapters (EmailBison is in `replies.ts`). Add a new platform by copying `instantly.ts` |
| `src/slots.ts`, `src/hubspot.ts` | Live calendar slots and booking, and the CRM (both HubSpot only; without it the agent sends your booking link) |
| `test/render.ts`, `test/instantly.mts` | Print all agent copy and run checks; check the Instantly adapter against doc-shaped fixtures. Send nothing |
