// Reply agent. The model only PICKS an action and never writes to a lead. Code fills the approved copy from client.ts,
// so nothing unapproved can reach a lead.

import { C, offerFor, type Offer } from "./client.js";
export { offerFor, type Offer };

const OFFER_DO = (o: Offer) => C.offers[o].doVerb;

export const SYSTEM_PROMPT = `You sort replies to cold emails sent for ${C.name}.

## Who ${C.name} is
${C.name} ${C.whatTheyDo}. The ${C.owner.title} is ${C.owner.full}. The emails are signed by ${C.signedBy}.

## What we sent (one of these)
${Object.values(C.offers).map((o) => `- ${o.sent}`).join("\n")}

## Your job
Pick ONE action. You never write a message to the lead.

| If the reply is... | Action |
|---|---|
| A plain yes to what we offered, with nothing else in it: "yes", "sure", "send it over", "yes please send the list", "sounds good", "I'd like to see it", "interested", "I'm interested", "yes, interested", "send over more info" | TEMPLATE |
| ONLY a question about what ${C.name} is / who we are / what we do ("tell me more about yourself", "what do you do?") | ANSWER, topic "about" |
| ONLY a question about price ("what does it cost?", "is this free?") | ANSWER, topic "cost" |
| ONLY a question about where the data or their email came from | ANSWER, topic "data" |
| ONLY a question about whether we are real or trustworthy ("is this legit?") | ANSWER, topic "legit" |
| ONLY a condition on getting the offer ("only if it's free", "email it to me first", "send the info before a call") | ANSWER, topic "condition" |
| ONLY a question about what we need from them ("what do you need from me?", "what's involved?") | ANSWER, topic "needs" |
| ONLY asking how the offer works, how we'd approach it, what the next steps are, or for more details on the process ("how would you approach this?", "what would the next steps look like?", "please share more details") | ANSWER, topic "how" |
| ONLY a question about the call itself: what it's on (Zoom, Google Meet, Teams), how long it is, or whether they'll share their screen ("is it a Zoom?", "is it a Google meeting thing where I share my screen?") | ANSWER, topic "call" |
| ONLY their own booking link or "book on my calendar" | ANSWER, topic "own_link" |
| ONLY a clear day or time of their own ("Thursday at 2pm works", "can we do Friday morning at 10?") with a date or weekday AND an hour | TIME |
| Anything else | HUMAN |

If a yes, "interested" or an answerable question ALSO names ONE other person or address to bring in ("yes send it, cc'ing dana@brand.com"), still pick TEMPLATE or ANSWER and add "referral_email" with that address (and "referral_name" if given). We reply to them and also email that person.

"ONLY" means no other question or condition is in the reply. A yes or "interested" in front of ONE question or condition does not count against it: "Yes! How much does it cost?" is ANSWER, topic "cost". If it asks two things, mixes a question with a condition, or adds anything else, choose HUMAN. Exception: how it works, how we'd approach it, next steps and "more details" are all ONE topic ("how"), so "We're interested in testing your approach to creator performance and GMV Max. Please share how you'd approach this and what the next steps look like." is ANSWER, topic "how". Also, what we need from them and how the call works are ONE topic ("call"), so "Sure thing - what do you need to get started? Is it a Google meeting thing where I share my screen?" is ANSWER, topic "call". Asking us to phone them, or for a phone number, is still HUMAN.

Choose HUMAN if the reply includes ANY of these:
- any other question (a different question, or more than one);
- any other condition;
- a request for a phone number, a deck or a document;
- a vague time ("sometime next week", "mornings"), or more than one possible time;
- they only point us to another person or address instead of answering (a referral: "talk to my colleague", "send this to our marketing lead") - that is HUMAN with category referral;
- confusion, suspicion, sarcasm, or a correction of our numbers;
- anything negative, "not interested", "we have an agency", or an unsubscribe / remove-me request;
- an out-of-office message, auto-reply or bounce;
- them selling something to us;
- a reply you are unsure about.

When in doubt, choose HUMAN.

## Category (for HUMAN only)
- interested: positive but needs a person (a question, a condition, a time, a call request)
- question: a question without a clear yes or no
- referral: a reply about OUR offer that sends us to another person, team or email address for it, or copies someone in. Examples: "talk to Priya, she runs our marketing", "for partnerships please email partnerships@brand.com", "I've passed this to our marketing team", a support team saying "send proposals like this to business@brand.com". A canned partnership/collaboration redirect counts as a referral.
- not_interested: a no
- unsubscribe: asks to be removed or to stop emailing
- auto_reply: any automated or out-of-office message, EVEN IF it names someone else to contact. This includes: out of office / on leave / travelling ("for urgent matters contact X"); "X is no longer with the company, please contact Y"; "this inbox is no longer monitored, email Y"; support ticket confirmations, ticket updates ("your request has been updated"), satisfaction surveys, business-hours notices, "we received your message". These are not about our offer, so they are never a referral.
- other: anything else

Referral vs auto_reply: if the message would have been sent the same way to anyone who emailed that address (an out-of-office, a "left the company" notice, a ticket receipt), it is auto_reply. Only call it a referral if it responds to what we offered or is a standing partnership/collaboration redirect.

A canned reply that is sent to everyone who writes in is an auto_reply, even if it sounds warm. Example: "we're glad you're interested in cooperating with us! Submit a sample request through the window, or email our influencer team" is a template, not an answer to our offer, so it is auto_reply.

If the reply is confused, off-topic, or only asks what we want ("so what you want to express"), use other. It is not interested and not a referral.

For a referral, also give "referral_email": the ONE email address they want us to contact about our offer, copied exactly from the reply. If they name no address, or name more than one, give "". Give "referral_name" only if the reply names that person's first name, else "".

## First name
For TEMPLATE, give the person's first name from the reply's sign-off, or else from the lead record. If there is no real first name (blank, "there", "Team", a company name, initials), give "".

## Output
Return exactly one JSON object and nothing else:
{"action":"send","first_name":"Jess"}
{"action":"send","first_name":"Jess","referral_email":"dana@brand.com","referral_name":"Dana"}
{"action":"answer","topic":"about","first_name":"Jess"}
{"action":"time","first_name":"Jess"}
{"action":"human","category":"question","reason":"<one short line for ${C.owner.first}>"}
{"action":"human","category":"referral","referral_email":"business@brand.com","referral_name":"","reason":"<one short line for ${C.owner.first}>"}`;

export const FOLLOWUP_PROMPT = `You read a lead's reply in an email thread where we have already answered them, to help book a call with ${C.owner.full}, ${C.owner.title} of ${C.name} (${C.descriptor}).

You get our last message (it may list call times, like "Tuesday Nov 17 at 12:00 PM ET") and their newest reply.

Pick ONE action. You never write a message to the lead.

| If their reply is... | Action |
|---|---|
| A clear pick of ONE of the times we listed ("Tuesday works", "the 12pm one", "let's do Thursday") | book, with "slot" set to that line copied exactly from our message |
| A clear, specific time of their own with a date or weekday AND an hour ("Friday at 2pm ET") | book, with "time" set to that moment as an ISO 8601 date-time with offset (assume ET if no zone; use the year of the listed times) |
| None of the times work, or they ask for other times / another day / next week, with nothing else in it | new_times |
| ONLY a question about what ${C.name} is (topic "about"), price ("cost"), where the data came from ("data"), whether we are legit ("legit"), what we need from them ("needs"), how the offer works / how we'd approach it / what the next steps are ("how"), how the call works - Zoom or Google Meet, how long, screen sharing, alone or with what we need from them ("call"), or ONLY a condition on getting the offer ("condition") | answer, with "topic" set to the word in quotes |
| ONLY a thank-you with no ask and no time ("thanks!", "you're welcome", "thank you") | ack |
| Anything else | human |

"ONLY" means no other question or condition is in the reply. A thank-you or yes in front of ONE question is still answer. Two questions, or a question plus anything else, is human. "Sounds good", "great" or "ok" with no time picked is human, not ack.

A time proposed as a question ("Can we do Friday at 2pm instead?") is a specific time, not a question.

Choose human if the reply includes ANY of these: any other question; a condition; asking for a phone number, deck, document or info first; another person or email (cc's are fine if they also pick a time); rescheduling or cancelling something already booked; a vague time ("sometime next week", "mornings"); more than one possible time; confusion; anything negative or an unsubscribe; an out-of-office or automated message; a reply you are unsure about.

When in doubt, choose human.

For human, set category to "auto_reply" when the reply is automated: out of office, on leave, "no longer with the company", inbox not monitored, ticket receipt or update, satisfaction survey, business-hours notice. Otherwise use one of: interested, question, referral, not_interested, unsubscribe, other.

## First name
Give the person's first name from the reply's sign-off, or else from the lead record. If there is no real first name, give "".

## Output
Return exactly one JSON object and nothing else:
{"action":"book","slot":"Tuesday Nov 17 at 12:00 PM ET","first_name":"Jess"}
{"action":"book","time":"2026-11-20T14:00:00-05:00","first_name":"Jess"}
{"action":"new_times","first_name":"Jess"}
{"action":"answer","topic":"needs","first_name":"Jess"}
{"action":"ack"}
{"action":"human","category":"question","reason":"<one short line for the team>"}`;

export interface FollowUp {
  action: "book" | "new_times" | "answer" | "ack" | "human";
  topic?: Topic;
  slot?: string;
  time?: string;
  first_name?: string;
  category?: string;
  reason?: string;
}

export function parseFollowUp(raw: string): FollowUp {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { action: "human", category: "other", reason: "model output unreadable" };
  try {
    const d = JSON.parse(m[0]) as FollowUp;
    if (d.action === "book" && (d.slot || d.time)) return d;
    if (d.action === "new_times" || d.action === "ack") return d;
    if (d.action === "answer" && TOPICS.has(d.topic ?? "")) return d;
    if (d.action === "human") return { action: "human", category: d.category ?? "other", reason: d.reason ?? "" };
  } catch { /* fall through */ }
  return { action: "human", category: "other", reason: "model output invalid" };
}

/** Slot lines ("Tuesday Nov 17 at 12:00 PM ET") listed in one of our messages. */
export function offeredSlots(text: string): string[] {
  return [...text.matchAll(/[A-Z][a-z]+day [A-Z][a-z]{2} \d{1,2} at \d{1,2}:\d{2} [AP]M ET/g)].map((m) => m[0]);
}

export type Topic = "about" | "cost" | "data" | "legit" | "condition" | "own_link" | "needs" | "how" | "call";
const TOPICS = new Set<string>(["about", "cost", "data", "legit", "condition", "own_link", "needs", "how", "call"]);

export interface Decision {
  action: "send" | "answer" | "time" | "human";
  topic?: Topic;
  first_name?: string;
  category?: string;
  reason?: string;
  referral_email?: string;
  referral_name?: string;
}

const BAD_NAMES = new Set(["", "there", "team", "hi", "hello", "sir", "madam", "info", "admin", "office", "support", "hello"]);

export function cleanFirstName(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    const n = (c ?? "").trim().split(/\s+/)[0] ?? "";
    // an all-caps word of 3+ letters is a brand handle ("ACME"), not a first name
    if (/^[A-Za-z][A-Za-z'-]{1,24}$/.test(n) && !BAD_NAMES.has(n.toLowerCase()) && !/^[A-Z]{3,}$/.test(n)) return n[0].toUpperCase() + n.slice(1);
  }
  return "";
}

const isOwner = (sender: string) => sender.trim().toLowerCase() === C.owner.first.toLowerCase();

// Every first reply leads with who we are and how the free offer works, in a teammate's voice, then the call as the
// first step, with times so they can book in one reply. All wording comes from client.ts.
const ABOUT = C.copy.about;
const HOW_OFFER = C.copy.how;
const FIRST_STEP = C.copy.firstStep;

/** The times block a reply ends with: up to 3 times, then the booking link (just the link if the calendar can't be read). */
function scheduleBlock(slotLabels: string[], bookingLink: string): string {
  return slotLabels.length
    ? `A few times that work:\n\n${slotLabels.join("\n")}\n\nOr grab any time here: ${bookingLink}`
    : `Grab any time that suits you here: ${bookingLink}`;
}

/** The main reply: who we are, how the offer works, then the call. For a plain yes and for "tell me more / how does it work / email it first". */
function infoBody(offer: Offer, slotLabels: string[], bookingLink: string): string {
  const what = offer === "tertiary"
    ? `${ABOUT}\n\n${C.copy.tertiaryLead} ${HOW_OFFER}`
    : `${ABOUT}\n\n${HOW_OFFER}`;
  return `Happy to. ${what}\n\n${FIRST_STEP} ${scheduleBlock(slotLabels, bookingLink)}`;
}

/** Plain yes. Signed by the inbox that sent the campaign email. */
export function templateMessage(firstName: string, offer: Offer, slotLabels: string[], sender: string, bookingLink: string): string {
  const hi = firstName ? `Hey ${firstName},` : "Hey there,";
  return `${hi}\n\n${infoBody(offer, slotLabels, bookingLink)}\n\n${sender}`;
}

/** Approved answers to the one-topic replies the model is allowed to pick. */
export function answerMessage(topic: Topic, firstName: string, slotLabels: string[], sender: string, bookingLink: string): string {
  const hi = firstName ? `Hey ${firstName},` : "Hey there,";
  const sched = scheduleBlock(slotLabels, bookingLink);
  const info = infoBody("primary", slotLabels, bookingLink);
  const needs = `${C.copy.needs} ${sched}`;
  const body: Record<Topic, string> = {
    about: info,
    how: info,
    condition: info,
    cost: `${C.copy.cost}\n\n${FIRST_STEP} ${sched}`,
    legit: `${C.copy.legit}\n\nHappy to walk you through it on a short call. ${sched}`,
    data: `${C.copy.data}\n\nHappy to walk you through what we found on a short call. ${sched}`,
    needs,
    call: needs, // Do not promise screen sharing unless the client confirmed it.
    own_link: `Thanks. It's easier on our side to book through our calendar. ${sched}`,
  };
  return `${hi}\n\n${body[topic]}\n\n${sender}`;
}

/** Follow-up turn: they picked a time and it's booked. HubSpot sends the invite. */
export function confirmMessage(firstName: string, slotLabel: string, sender: string): string {
  const hi = firstName ? `Perfect, ${firstName}.` : "Perfect.";
  return `${hi} You're booked in for ${slotLabel}. You'll get a calendar invite shortly. Speak then.\n\n${sender}`;
}

/** Follow-up turn: none of the offered times work. New days, or the booking link if the calendar can't be read. */
export function newTimesMessage(firstName: string, slotLabels: string[], sender: string, bookingLink: string, taken = false): string {
  const hi = taken
    ? `${firstName ? `Thanks ${firstName}, that` : "Thanks, that"} time isn't free on our calendar.`
    : firstName ? `No problem, ${firstName}.` : "No problem.";
  const body = slotLabels.length
    ? `How about one of these instead?\n\n${slotLabels.join("\n")}\n\nOr grab any other time on our calendar: ${bookingLink}`
    : `Here's our calendar, grab whichever time suits you: ${bookingLink}`;
  return `${hi} ${body}\n\n${sender}`;
}

/** Nudge when a lead said yes but went quiet. 1 = times again (or the link), 2 = last one, link only. Max 2, no breakup. */
export function nudgeMessage(n: 1 | 2, firstName: string, offer: Offer, slotLabels: string[], sender: string, bookingLink: string): string {
  const hi = firstName ? `Hey ${firstName},` : "Hey there,";
  if (n === 1) {
    const body = slotLabels.length
      ? `just bumping this. Which one of these times works best for you?\n\n${slotLabels.join("\n")}\n\nOr grab any other time that suits you: ${bookingLink}`
      : `just bumping this. Grab whichever time suits you: ${bookingLink}`;
    return `${hi} ${body}\n\n${sender}`;
  }
  return `${hi} ${C.copy.nudge2(OFFER_DO(offer))} Grab a time here: ${bookingLink}\n\n${sender}`;
}

/** Positive/question/referral that needs the owner himself. Signed by the sending inbox's first name. */
export function handoffMessage(firstName: string, sender: string): string {
  const thanks = firstName ? `Thanks ${firstName}.` : "Thanks.";
  return `${thanks} ${isOwner(sender) ? C.copy.handoffOwner : C.copy.handoffTeam}\n\n${sender}`;
}

const OFFER_LINE: Record<Offer, (brand: string) => string> = {
  primary: (b) => C.copy.referralOffer.primary(b),
  secondary: (b) => C.copy.referralOffer.secondary(b),
  tertiary: (b) => C.copy.referralOffer.tertiary(b),
};

/** Email to the address a lead pointed us to. Same offer as the campaign, one question, signed by the sending inbox.
 *  Goes out only when REFERRALS=send. */
export function referralMessage(p: { toFirst: string; brand: string; offer: Offer; sender: string }): string {
  const hi = p.toFirst ? `Hey ${p.toFirst},` : "Hey there,";
  const brand = p.brand.trim() || "your";
  return `${hi}\n\nYour team pointed me to you.\n\n${OFFER_LINE[p.offer](brand)}\n\nInterested?\n\n${p.sender}`;
}

/** The one address worth emailing, or null. Rejects no-reply boxes, the lead's own address, our own inboxes and anything malformed. */
export function validReferralEmail(raw: string | undefined, opts: { leadEmail: string; ownDomains: string[] }): string | null {
  const e = (raw ?? "").trim().toLowerCase().replace(/^[<[(\s]+/, "").replace(/^mailto:/, "").replace(/[>\]),.;\s]+$/, "");
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(e)) return null;
  if (/^(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster)@/.test(e)) return null;
  if (e === opts.leadEmail.trim().toLowerCase()) return null;
  const domain = e.split("@")[1];
  if (opts.ownDomains.some((d) => d && domain === d.toLowerCase())) return null;
  return e;
}

export function parseDecision(raw: string): Decision {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { action: "human", category: "other", reason: "model output unreadable" };
  try {
    const d = JSON.parse(m[0]) as Decision;
    if (d.action === "send" || d.action === "time") return d;
    if (d.action === "answer" && TOPICS.has(d.topic ?? "")) return d;
    if (d.action === "human") return { action: "human", category: d.category ?? "other", reason: d.reason ?? "", referral_email: d.referral_email, referral_name: d.referral_name };
  } catch { /* fall through */ }
  return { action: "human", category: "other", reason: "model output invalid" };
}

// Bison shows our agent's replies and hand-written ones the same way (both Sent, both with a scheduled_email_id),
// so the agent tags its own: an invisible attribute on the wrapper div. Older agent replies (before the tag) are
// recognised by their fixed wording.
const AGENT_ATTR = "data-cl-agent";
const AGENT_PHRASES = C.agentPhrases;

export function toHtml(text: string, asPerson = false): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // A message a person typed in Slack carries no agent tag, so the agent treats the thread as theirs.
  return `<div${asPerson ? "" : ` ${AGENT_ATTR}="1"`}>${esc.replace(/\n/g, "<br>")}</div>`;
}

/** True if this Sent message was written by the agent, not by a person. */
export function isAgentMessage(m: { html_body?: string | null; text_body?: string | null }): boolean {
  if ((m.html_body ?? "").includes(AGENT_ATTR)) return true;
  const own = latestMessage(m.text_body ?? "");
  return AGENT_PHRASES.some((p) => own.includes(p));
}

/** Body for Bison POST /replies/{id}/reply: answer the person who replied, in-thread, with cc. */
export function replyBody(p: { message: string; senderEmailId: number; to: { name: string | null; email: string }; cc: string[]; asPerson?: boolean }) {
  return {
    message: toHtml(p.message, p.asPerson),
    content_type: "html",
    inject_previous_email_body: true,
    sender_email_id: p.senderEmailId,
    to_emails: [{ name: p.to.name, email_address: p.to.email }],
    cc_emails: p.cc.filter(Boolean).map((e) => ({ name: null, email_address: e })),
  };
}

/** Strip quoted history so we judge only what the person wrote. */
export function latestMessage(text: string): string {
  const cut = text.split(/(?:^|\n)\s*On .{5,140} wrote:|\n-{2,}\s*Original Message|\n\s*>|\nFrom:\s.+\n/i)[0];
  return cut.trim().slice(0, 2000);
}
