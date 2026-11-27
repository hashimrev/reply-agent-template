# Reply agent for cold email: guide

A ready-made agent that handles the replies to your cold email. It works with Instantly, EmailBison and PlusVibe, and runs on Trigger.dev. An AI coding agent (Claude Code) sets it up for you by interviewing you first.

## What it does

1. Checks your sending inbox every minute for new replies.
2. A model picks one action for each reply: a plain yes, an answer to one known question, a time the lead suggested, or hand it to a person. It never writes to a lead. Code fills in wording you approved.
3. Replies in the same thread from the same inbox.
4. With HubSpot it offers up to 3 live call times and books the one the lead picks. With any other calendar it sends your booking link.
5. Posts every decision to Slack as a card. A person can answer from the Slack thread.
6. Nudges a lead who said yes and went quiet, twice (24 hours, then 48), never on weekends. It stops the moment anyone replies by hand.
7. Handles referrals ("talk to my colleague") and leads who book through your link.
8. Optionally puts positive leads into HubSpot.
9. For anything the ready-made answers don't cover, it can write a reply from your knowledge base. A second model call and fixed rules check it. If either fails, a person gets it.

It starts in shadow mode. It posts what it would send, and sends nothing, until you switch it on.

## What it will not do

- Write freely to leads. Everything outside free-text mode is wording you approved.
- Answer unsubscribes or angry replies. Those go to a person.
- Send emails in languages other than English.
- Book calls without HubSpot. With another calendar it sends your link.
- Update a CRM other than HubSpot.
- Handle very high volume on Instantly. It allows about 20 requests a minute. Above roughly 300 replies a day you need a different scan plan.

The Instantly connection was checked against the API docs, not a live account. The first real run is the real test.

## What you need

| Item | Notes |
|---|---|
| A sending platform | Instantly (API v2), EmailBison or PlusVibe, with an API key |
| Trigger.dev account | Free to start. Runs the agent |
| OpenRouter key | Gives the agent its model |
| Slack | A webhook is enough. A bot token lets people answer from a card |
| HubSpot (optional) | A private-app token from the owner's portal, for live slots, booking and deals |
| Your material | Your email scripts, campaign names, and two or three real replies you like |
| Claude Code | To run the setup |

## How to start

1. Copy the `reply-agent-template` folder.
2. Open it in Claude Code.
3. Say: **"Follow CLAUDE.md and set up a reply agent for me."**

The agent interviews you first. It builds nothing until you approve what it plans.

## The setup process

### Phase 0: the interview
It asks a few questions at a time, with a recommended default for each:

- **Who you are and who you write to.** Your business, your audience, one person or a team, which markets.
- **What you send.** The platform, your step 1 and step 2 scripts, exact campaign names, how many campaigns run, the call to action in each, reply volume.
- **What a good reply is.** Five real examples, what must always go to a human, what should happen after a yes, auto-send or approve each reply.
- **Booking and CRM.** Which calendar, which CRM.
- **Voice and proof.** Two or three real replies you are happy with, what proof you may use, your pricing and what the agent may say about it, anything it must never say.
- **Compliance.** Where your leads came from, how you handle "stop" and unsubscribes, and for recruiters whether it may ever discuss personal details.
- **Setup.** Which accounts you already have, who reads the Slack cards and when, how comfortable you are with the terminal.

### Phase 1: the Fit Report
Before any edit it writes a report with four parts:
1. What fits as it stands.
2. What needs changing, one line per gap.
3. What it needs from you.
4. What this will not do.

You approve or change it. Nothing is built before that.

### Phase 2: the build
1. **`src/client.ts`**: your name, offers, approved wording and banned words. Never the AI's own marketing copy.
2. **`knowledge.md`**: the facts the free-text writer may use. Every fact is tagged CONFIRMED, APPROVED or NOT CONFIRMED.
3. **The classifier prompt**: the nine generic topics are mapped to your business.
4. **Sign-off**: it prints everything the agent can ever send. You read it all and fix any wording.
5. **Services**: Trigger.dev project, sending platform key, Slack, HubSpot. Keys go in the Trigger.dev project, never in a file.
6. **Deploy in shadow mode.**
7. **Shadow period.** A few days of reading every Slack card. Replay your hard cases: a hostile reply, a fee question, an out-of-office, a referral. Fix wording. Only then switch to send.

## Settings

Set these in the Trigger.dev project, Production environment.

| Setting | What |
|---|---|
| `OPENROUTER_API_KEY` | Model access |
| `SLACK_WEBHOOK_URL` | Where decisions are posted |
| `BOOKING_LINK` | Your booking page |
| `INSTANTLY_API_KEY` or `EMAILBISON_API_KEY` or `PLUSVIBE_API_KEY` | The one platform you use |
| `MODE` (and the platform's own switch) | `shadow` (default) or `send` |
| `HUBSPOT_TOKEN` and pipeline and stage ids | Optional. Live slots, booking, deals |
| `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_OWNER_USER_ID`, `SLACK_REPLY_USERS` | Optional. Answer from Slack |
| `GRACE_MINUTES`, `NUDGES`, `FREE_TEXT`, `REFERRALS`, `MODEL` | Tuning. Defaults are safe |

## How it decides

1. A scan runs every minute and finds new replies not seen in the last 48 hours.
2. The model picks one action.
3. Code builds the message from your approved wording.
4. It waits a few minutes and re-reads the thread. If a person already answered, it stops.
5. Free-text mode runs only for replies the approved answers don't cover: a writer, then a guard, then fixed rules. Any failure goes to a person.
6. Nudges go only to a plain yes that went quiet, and stand down the moment the thread moves.

## Rules it follows

- The model never writes to a lead, except in free-text mode, which is fenced by your knowledge base and a guard.
- It never invents copy, numbers, names, results, fees or timelines. Anything you haven't told it goes on a list of gaps.
- Plain text, no em dashes, no "it's not X, it's Y" wording, at most 2 nudges, no breakup email.
- Shadow mode first. Going live needs your explicit yes.
- Deploying, setting settings and switching to send all need your yes.
- No secrets in files.

## What's in the folder

| Path | What |
|---|---|
| `CLAUDE.md` | The full instructions the AI agent follows |
| `src/client.ts` | Everything specific to you: name, offers, approved wording, banned words |
| `knowledge.md` | The facts the writer may use |
| `src/prompt.ts` | Classifier prompts and copy templates. The same for every client |
| `src/replies.ts` | The scan, send, nudge, Slack and booking tasks |
| `src/compose.ts` | The free-text writer and its guard |
| `src/instantly.ts`, `src/plusvibe.ts` | Adapters for those platforms. EmailBison is in `replies.ts`. A new platform copies `instantly.ts` |
| `src/slots.ts`, `src/hubspot.ts` | Live calendar slots, booking and the CRM. HubSpot only |
| `examples/` | A made-up recruiting example showing what a finished setup looks like |
| `test/` | Scripts that print all the agent's wording and check the adapters. They send nothing |

## Commands

```bash
npm install
npm test            # typecheck, copy render, Instantly adapter check
npm run test:render # prints every message the agent can send, for sign-off
npm run deploy      # regenerates the knowledge file, then deploys to Trigger.dev
```
