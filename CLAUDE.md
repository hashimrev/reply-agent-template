# Reply agent: interview and setup playbook for an AI agent

You are turning this template into one person's reply agent for their cold email. **Do not touch any code or config until the interview (Phase 0) is done and the person has approved your Fit Report (Phase 1).** The template was built for one case. It will not fit every case as it stands, and your first job is to find out where it does not.

## What this agent is (so you can judge fit)

It watches a sending platform for replies to cold email. For each new reply a model PICKS one action: plain yes, answer one known topic, a time they proposed, or hand to a person. It never writes to a lead. Code fills approved copy from `src/client.ts`. An optional free-text mode writes a reply from `knowledge.md`, checked by a second model call and fixed rules. It can offer live call times and book them (HubSpot only), nudge a lead who said yes and went quiet, post every decision to Slack, take a Slack reply from a person, handle referrals, and put positives into HubSpot.

Sending platforms it speaks to: **Instantly (API v2)**, EmailBison, PlusVibe. Anything else needs a new adapter (see `src/instantly.ts` as the pattern, about 150 lines).

## Hard rules

- The model never writes to a lead, except in free-text mode, which is fenced by `knowledge.md` and a guard. Every other lead-facing word comes from `src/client.ts`.
- Never invent copy, numbers, placements, client or candidate names, results, fees, timelines or capabilities. If the person has not told you, it does not go in. List it as a gap.
- Copy rules: plain text, no em dashes (use "-"). Never use the "It's not X, it's Y" reframe. Max 2 nudges, no breakup email.
- Start in shadow mode. Going live (`...MODE=send`) needs the person's explicit yes after a shadow period.
- Every outward or paid action needs their yes: deploying, setting env vars, creating a Slack app, switching to send.
- No secrets in files. Env vars live in the Trigger.dev project only.
- Ask a few questions at a time (3 to 6), give your recommended default for each, and wait. Never dump the whole list. If you have a question tool, use it.

## Phase 0: the interview

Ask in this order. Each block says why you ask, so you know what the answer changes. Skip a question only if the person already answered it in material they gave you. Record every answer in `docs/interview.md` (create it) as you go.

### A. Who they are and who they write to
1. Describe your business in two sentences. Who are you, and what do you sell or offer?
2. Who do your cold emails go to? (hiring managers, candidates, both, other.) *Changes the offer wording and the whole `knowledge.md`.*
3. Are you one person or a team? Whose name is on the emails and who takes calls? *Sets `teamVoice`. One person means first-person copy ("I").*
4. Which markets and regions? *Drives data-source answers and compliance wording.*

### B. What they send, and from where
5. Which platform sends the email? (Instantly, EmailBison, PlusVibe, other.) *Other means a new adapter, and the Fit Report must say so.*
6. Paste your step 1 and step 2 scripts, and the exact campaign names in the platform. *`offers[*].sent` and `campaignHint` come from these. Names must contain a distinct word per offer.*
7. How many campaigns run at once, and what is the call to action in each last line? (a call, a CV, a role spec, a reply.) *Each distinct last line is one offer. If the CTA is not a call, the copy blocks change.*
8. Roughly how many replies a day, and how many are positive? *Instantly allows 20 requests a minute on emails. High volume needs a different scan plan.*

### C. What a good reply is, and what they want done with it
9. What counts as a positive reply for you? Give 5 real examples, positive and negative. *Fixes the classifier. Use real replies, never invented ones.*
10. Which replies should always go to a human? (fee or salary negotiation, exclusivity, contracts, anything legal, complaints.) *Becomes `knowledge.md` section 10.*
11. When a lead says yes, what should happen next? (book a call, send a document, ask for details first.) *If the answer is not "book a call", rewrite `copy.firstStep` and `copy.how` around the real next step.*
12. Should replies send automatically, or should a human approve each one first? *Auto-send means shadow then `MODE=send`. Approve-each means shadow mode stays on and a person sends from Slack. Both are supported.*

### D. Booking and CRM
13. Which calendar do you use? (HubSpot meetings, Calendly, Cal.com, Google Calendar, none.) *HubSpot means live slots and booking. Anything else means link-only mode: the agent sends your link and never books.*
14. Which CRM or ATS do you use? (HubSpot, Recruit CRM, Bullhorn, Pipedrive, a sheet, none.) *Only HubSpot is built. Anything else is a note in the Fit Report, and positives are tracked in Slack only.*

### E. Voice and proof
15. Paste two or three real replies you have sent that you are happy with. *Sets the voice for `copy.*`.*
16. What proof can I use, and which of it may I name? (placements, years, sectors.) *Goes in `knowledge.md` section 5. Anything not given stays out.*
17. What is your price or fee structure, and what may the agent say about it? *Usually: say how it works, never quote a figure.*
18. Is there anything the agent must never say? (competitor names, guarantees, salary numbers.) *Goes in `banned` and the hand-to-person list.*

### F. Compliance and trust (ask these for any recruiter or any EU or UK audience)
19. Where did the leads come from, and what is the honest answer to "where did you get my details"? *`copy.data` must be true. Do not write a reassuring line you cannot back up.*
20. How do you handle "remove me" or "stop"? Is there an unsubscribe in the emails? *Unsubscribes are never answered by the agent. Confirm where they are logged.*
21. For recruiters: should the agent ever discuss a candidate's personal details, age, gender, nationality, health or any protected characteristic? *The answer should be no. Add it as a hand-to-person rule.*

### G. Setup and who watches it
22. Do you already have: a Trigger.dev account, an OpenRouter key, a Slack workspace where you can add a webhook? *Any "no" is a setup task for them. Trigger.dev and OpenRouter have free starts.*
23. Who reads the Slack cards, and during which hours? *Sets the grace wait and whether nudges are worth turning on.*
24. How comfortable are you with the terminal and deploys? *Decides how much you do for them and how much you explain.*

## Phase 1: the Fit Report (get approval before any edit)

Write `docs/fit-report.md` and show it. It has four parts.

1. **What fits as it stands.** The parts of the template that match their answers.
2. **What needs changing, and how.** One line per gap. Use this table to find them:

| If their answer is... | Then... |
|---|---|
| Platform is Instantly, EmailBison or PlusVibe | Use the built-in adapter. Set that platform's key only. |
| Platform is something else | Say plainly that it needs a new adapter, copy `src/instantly.ts` as the pattern, and ask whether to build it. |
| Calendar is HubSpot | Live slots and booking work. Needs a HubSpot private-app token from their own portal. |
| Calendar is anything else, or none | Link-only mode: `BOOKING_LINK` only, no `HUBSPOT_TOKEN`. The agent sends the link and never books. A lead who names a time goes to a person. Say this loses automatic booking. |
| No CRM, or a CRM other than HubSpot | Skip HubSpot. Positives live in Slack. If they want their CRM, it is a new module like `src/hubspot.ts`. |
| One person, no team | `teamVoice: false`, first-person copy, `handoffTeam` text rewritten or unused. |
| Next step after yes is not a call | Rewrite `copy.how` and `copy.firstStep`. Check every template that says "call". |
| They want a human to approve every reply | Keep shadow mode. They send from the Slack thread. Do not set `MODE=send`. |
| More than about 300 replies a day | Warn: Instantly's 20 requests a minute limit. Propose a lower scan frequency or webhooks. |
| They send in a language other than English | Not supported as it stands. Copy and the classifier prompt are English. Say so. |
| Referrals matter to them on Instantly | Instantly can only answer the original sender, so referral emails are Slack drafts they send by hand. |

3. **What I need from you.** The open questions and missing material, as a short list.
4. **What this will not do.** Be specific. Do not oversell.

Stop. Wait for the person to approve or amend the Fit Report.

## Phase 2: build it

### 1. `src/client.ts`
Work through every field. `examples/northbridge-recruiting/client.ts` is a filled-in **fictional** example of a solo recruiter. Do not reuse any of its content.
- `offers`: one entry per distinct last line. `sent` is the campaign's last line, verbatim. `campaignHint` is a word in the campaign name.
- `copy.*`: the client's own wording and voice, from their real replies (Q15). Never your own marketing copy.
- `agentPhrases`: 5 to 8 distinctive phrases from the templates you wrote.
- `banned`: their name (if team voice), tool names, anything from Q18.
- Set `configured: true` only when every `<placeholder>` is gone.

### 2. `knowledge.md`
Follow the skeleton. Tag every fact CONFIRMED, APPROVED or NOT CONFIRMED. Open questions go in section 11. Then run `npm run gen:knowledge`.

### 3. The classifier prompt
Read `SYSTEM_PROMPT` in `src/prompt.ts`. The nine topics are generic. Map them to this client: `cost` is their fees or pay, `data` is where you got their details, `needs` is what you need from them (a job spec, a CV), `call` is how the call works. Edit the prompt only where their replies genuinely differ. Keep "When in doubt, choose HUMAN."

### 4. Print everything the agent can send and get sign-off
```bash
npm install
npm test
```
Show the printed copy from `npm run test:render` to the person. Fix wording in `src/client.ts`, never in `prompt.ts`.

### 5. Configure services (names in `.env.example`)
- **Trigger.dev**: set `project` in `trigger.config.ts` to their project ref.
- **Instantly**: an API v2 key with scopes `emails:read`, `emails:create`, `leads:read`, `campaigns:read`, `accounts:read`. Set `INSTANTLY_API_KEY` and `INSTANTLY_MODE=shadow`.
- **Slack**: a webhook is enough. For "answer from Slack", add a bot token with `chat:write` and `channels:history`, and set `SLACK_CHANNEL_ID`, `SLACK_REPLY_USERS`, `SLACK_OWNER_USER_ID`.
- **HubSpot** (optional): private-app token with the scopes in `.env.example`.
- Set env vars in the Trigger.dev project (production), never in a file.

### 5b. Instantly notes
- The adapter has been checked against fixtures built from the API docs, not against a live Instantly account. The first real run is the real test. Watch the logs.
- Reply ids are `<thread_id>:<email_id>`. The agent replies with `POST /emails/reply` from the same mailbox.
- Instantly replies only to the original sender. Referral emails to a new address are Slack drafts.
- Instantly has no per-reply link the agent can build for Slack cards, so cards carry no "open in Instantly" link.

### 6. Deploy in shadow mode
```bash
npm run deploy
```
The deploy CLI is pinned to the SDK (4.8.3). If it complains about a version mismatch, change both to the same version.

### 7. Shadow period, then go live
Run in shadow for a few days. Read every Slack card. Replay their real hard cases (a hostile reply, a fee question, a referral, an out-of-office). Fix copy in `client.ts`. Only then ask for `...MODE=send`.

## How it decides (so you can debug it)

1. A scan task runs every minute and finds new replies not seen in the last 48 hours. A scan for a platform with no API key does nothing.
2. `processReply` asks the model to PICK: `send` (plain yes), `answer` (one topic), `time`, or `human`.
3. Code builds the message from `client.ts` copy. Nothing the model wrote reaches the lead.
4. It waits `GRACE_MINUTES`, re-reads the thread, and cancels if a person answered.
5. Free-text mode runs only for replies the approved answers do not cover: writer, then guard, then fixed rules. Any failure goes to a person.
6. Nudges: only a plain yes that went quiet gets one, never on a weekend, and they stand down the moment anything in the thread moves.

## Do not

- Do not edit `src/prompt.ts` copy to change wording. Change `src/client.ts`.
- Do not add examples naming real people or companies to the classifier prompt.
- Do not widen free-text mode by loosening the guard. Add the fact to `knowledge.md`.
- Do not deploy, set env vars or switch to send without the person's yes.
- Do not claim a capability the Fit Report said is missing.
