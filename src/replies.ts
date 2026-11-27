import { schedules, task, logger, idempotencyKeys, wait } from "@trigger.dev/sdk";
import {
  SYSTEM_PROMPT, FOLLOWUP_PROMPT, parseDecision, parseFollowUp, cleanFirstName, templateMessage, answerMessage,
  confirmMessage, newTimesMessage, nudgeMessage, offeredSlots, isAgentMessage, replyBody, latestMessage, offerFor,
  referralMessage, validReferralEmail, toHtml,
  type Decision, type FollowUp,
} from "./prompt.js";
import { suggestSlots, availability, matchSlot, bookSlot, bookedSince, nextMeetingStart, nudgeTime, rollOffWeekend, label } from "./slots.js";
import { addLead, markBooked, addNote } from "./hubspot.js";
import { WRITER_PROMPT, GUARD_PROMPT, parseWritten, parseGuard, hardRules, assemble } from "./compose.js";
import { KNOWLEDGE } from "./knowledge.js";
import { C } from "./client.js";
import { pvThread, pvRecentReplies, pvFirstEmail, pvCampaignName, pvSendReply } from "./plusvibe.js";
import { instThread, instRecentReplies, instFirstEmail, instCampaignName, instSendReply, instAccountFirst } from "./instantly.js";

const BISON_BASE = process.env.BISON_BASE_URL || ""; // the EmailBison instance for this client, e.g. https://send.yourdomain.com/api (required when EMAILBISON_API_KEY is set)
const BISON_UI = BISON_BASE.replace(/\/api\/?$/, "");
const LOOKBACK_HOURS = 48; // each scan looks back this far; idempotency keys stop repeats
const MAX_SCAN_PAGES = 12; // 15 replies per page, newest first
const IDEMPOTENCY_TTL = "30d";
const DEFAULT_MODEL = "anthropic/claude-sonnet-5.5";

// MODE=shadow (default): decide, post to Slack what WOULD be sent. Nothing goes to leads.
// MODE=send: positive replies get an in-thread reply (no cc).
// Referrals (a lead points us to another address) are emailed only when REFERRALS=send; otherwise Slack shows the draft.
// PlusVibe has its own switch, PV_MODE, so it can stay in shadow while Bison sends.
type Src = "bison" | "plusvibe" | "instantly";
type Id = number | string;
const MODE_ENV: Record<Src, string> = { bison: "MODE", plusvibe: "PV_MODE", instantly: "INSTANTLY_MODE" }; // each sender has its own switch
const mode = (src: Src = "bison") => (process.env[MODE_ENV[src]] === "send" ? "send" : "shadow");
const isExternal = (src: Src) => src !== "bison"; // PlusVibe and Instantly: no Bison inbox ids, reply ids are "<thread>:<email>"

// Positive = plain yes (template) or these HUMAN categories (handoff line). Slack alerts on positive + referral.
const HANDOFF_CATEGORIES = new Set(["interested", "question", "referral"]);

interface BisonLead { id?: Id; first_name?: string | null; last_name?: string | null; email?: string | null; company?: string | null; title?: string | null }
/** A reply in Bison's shape. PlusVibe messages are converted into it (src "plusvibe", id "<thread_id>:<email_id>"). */
interface BisonReply {
  src?: Src;
  id: Id;
  eaccount?: string | null; // PlusVibe: our inbox
  eaccount_first?: string | null;
  html_body?: string | null;
  uuid?: string | null; // Bison only: the id in the thread URL
  interested: boolean;
  automated_reply: boolean;
  type?: string | null;
  folder?: string | null;
  subject?: string | null;
  text_body?: string | null;
  date_received: string;
  campaign_id?: Id | null;
  sender_email_id?: number | null;
  scheduled_email_id?: number | null;
  lead?: BisonLead | null;
  from_name?: string | null;
  from_email_address?: string | null;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

async function bison(path: string, init: { method?: string; body?: unknown } = {}) {
  if (!BISON_BASE) throw new Error("BISON_BASE_URL is not set");
  const res = await fetch(`${BISON_BASE}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${env("EMAILBISON_API_KEY")}`, Accept: "application/json", "Content-Type": "application/json" },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`Bison ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const isBounce = (r: BisonReply) => r.type === "Bounced" || r.folder === "Bounced";

// Minutes to wait after a reply lands before auto-replying, so a person can answer by hand first.
// 5 by default: prospects should hear back in about 5 minutes.
const graceMinutes = () => Number(process.env.GRACE_MINUTES ?? 5);

// The agent keeps going back and forth until the call is booked up to this
// many agent messages per thread. After that a person takes over.
const MAX_AGENT_TURNS = 6;

type Thread = { older_messages?: BisonReply[]; newer_messages?: BisonReply[] };
const isSent = (m: BisonReply) => m.folder === "Sent";
/** A person (not the agent) has written in this thread. */
const personInThread = (msgs: BisonReply[]) => msgs.some((m) => isSent(m) && !isAgentMessage(m));

/** True if anything has happened in the thread since this reply (anyone wrote after it). Campaign emails aren't part of Bison threads, so every Sent message is a reply. */
function answeredInThread(t: Thread): boolean {
  return (t.newer_messages ?? []).length > 0; // someone already answered AFTER this reply. Earlier person messages don't count.
}

const etTime = (ms: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(new Date(ms));

async function slackNote(text: string) {
  const res = await fetch(env("SLACK_WEBHOOK_URL"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`Slack ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Mailbox: the only places Bison and PlusVibe differ. Everything else reads a BisonReply.
const srcOf = (r: BisonReply): Src => r.src ?? "bison";

export async function getThread(src: Src, replyId: Id): Promise<Thread & { current_reply?: BisonReply }> {
  if (src === "plusvibe") return pvThread(String(replyId)) as any;
  if (src === "instantly") return instThread(String(replyId)) as any;
  return (await bison(`/replies/${replyId}/conversation-thread`)).data ?? {};
}

export async function campaignName(r: BisonReply): Promise<string> {
  if (srcOf(r) === "plusvibe") return `PlusVibe | ${await pvCampaignName(String(r.campaign_id ?? ""))}`;
  if (srcOf(r) === "instantly") return `Instantly | ${await instCampaignName(String(r.campaign_id ?? ""))}`;
  try { return (await bison(`/campaigns/${r.campaign_id}`))?.data?.name ?? `Campaign ${r.campaign_id}`; } catch { return `Campaign ${r.campaign_id}`; }
}

/** We know which inbox to answer from. */
const canSend = (r: BisonReply) => (isExternal(srcOf(r)) ? !!r.eaccount : !!r.sender_email_id);

/** One in-thread reply from the inbox that got the reply. Keyed by the caller so the same message never goes twice. */
async function sendReply(r: BisonReply, p: { toName: string | null; toEmail: string; message: string; asPerson?: boolean }, key: string) {
  const options = { idempotencyKey: await idempotencyKeys.create(key, { scope: "global" }), idempotencyKeyTTL: "30d" };
  if (srcOf(r) === "plusvibe") {
    return sendPlusvibeTask.triggerAndWait({ replyId: String(r.id), from: r.eaccount!, to: p.toEmail, subject: r.subject ?? "", message: p.message, asPerson: p.asPerson }, options);
  }
  if (srcOf(r) === "instantly") {
    return sendInstantlyTask.triggerAndWait({ replyId: String(r.id), from: r.eaccount!, subject: r.subject ?? "", message: p.message, asPerson: p.asPerson }, options);
  }
  return sendBisonTask.triggerAndWait({ replyId: Number(r.id), senderEmailId: r.sender_email_id!, ...p }, options);
}

export const sendInstantlyTask = task({
  id: "reply-send-instantly",
  retry: { maxAttempts: 3 },
  run: async (p: { replyId: string; from: string; subject: string; message: string; asPerson?: boolean }) => {
    const out = await instSendReply({ replyId: p.replyId, from: p.from, subject: p.subject, html: toHtml(p.message, p.asPerson) });
    return { sentId: out?.id ?? null };
  },
});

export const sendPlusvibeTask = task({
  id: "reply-send-plusvibe",
  retry: { maxAttempts: 3 },
  run: async (p: { replyId: string; from: string; to: string; subject: string; message: string; asPerson?: boolean }) => {
    const out = await pvSendReply({ replyId: p.replyId, from: p.from, to: p.to, subject: p.subject, html: toHtml(p.message, p.asPerson) });
    return { sentId: out?.id ?? null };
  },
});

export const scanBisonReplies = schedules.task({
  id: "reply-scan-replies",
  cron: "* * * * *", // every minute, so the scan adds at most ~1 minute on top of the grace period
  run: async () => {
    if (!process.env.EMAILBISON_API_KEY) return { skipped: "bison not used" }; // this client does not send through Bison
    if (!C.configured) throw new Error("src/client.ts is still the template. Fill it in from the client onboarding (see CLAUDE.md) and set configured: true.");
    const missing = ["EMAILBISON_API_KEY", "BISON_BASE_URL", "OPENROUTER_API_KEY", "SLACK_WEBHOOK_URL", "BOOKING_LINK"]
      .filter((k) => !process.env[k]);
    if (missing.length) {
      // Skip the whole scan so no reply is consumed while a destination is missing.
      logger.warn(`not configured: ${missing.join(", ")} - scan skipped, nothing consumed`);
      return { skipped: "not_configured", missing };
    }
    const since = Date.now() - LOOKBACK_HOURS * 3600 * 1000;
    const found: BisonReply[] = [];
    for (let page = 1; page <= MAX_SCAN_PAGES; page++) {
      const rows: BisonReply[] = (await bison(`/replies?per_page=15&page=${page}`)).data ?? [];
      if (!rows.length) break;
      let old = false;
      for (const r of rows) {
        if (new Date(r.date_received).getTime() < since) { old = true; continue; }
        // Only replies to a campaign (not warmup or notices), not bounces, not our own sent mail.
        if (r.campaign_id && !isBounce(r) && r.folder !== "Sent") found.push(r);
      }
      if (old) break;
    }
    logger.info(`found ${found.length} campaign replies in the last ${LOOKBACK_HOURS}h`, { mode: mode() });
    if (!found.length) return { found: 0 };
    // Keys MUST be global: plain-string keys made inside a task are scoped to that parent run,
    // so every scan would re-process (and re-post) every reply.
    const items = await Promise.all(
      found.map(async (r) => ({
        payload: { replyId: r.id },
        options: { idempotencyKey: await idempotencyKeys.create(`reply-reply:${r.id}`, { scope: "global" }), idempotencyKeyTTL: IDEMPOTENCY_TTL },
      }))
    );
    await processReply.batchTrigger(items);
    return { found: found.length, mode: mode() };
  },
});

export const scanInstantlyReplies = schedules.task({
  id: "reply-scan-instantly",
  cron: "* * * * *", // Instantly allows 20 requests a minute on emails, so one scan a minute leaves room for thread reads
  run: async () => {
    if (!process.env.INSTANTLY_API_KEY) return { skipped: "instantly not used" };
    if (!C.configured) throw new Error("src/client.ts is still the template. Fill it in from the client onboarding (see CLAUDE.md) and set configured: true.");
    const missing = ["OPENROUTER_API_KEY", "SLACK_WEBHOOK_URL", "BOOKING_LINK"].filter((k) => !process.env[k]);
    if (missing.length) {
      logger.warn(`not configured: ${missing.join(", ")} - Instantly scan skipped, nothing consumed`);
      return { skipped: "not_configured", missing };
    }
    const found = await instRecentReplies(Date.now() - LOOKBACK_HOURS * 3600 * 1000);
    logger.info(`found ${found.length} Instantly campaign replies in the last ${LOOKBACK_HOURS}h`, { mode: mode("instantly") });
    if (!found.length) return { found: 0 };
    const items = await Promise.all(
      found.map(async (r) => ({
        payload: { replyId: r.id, src: "instantly" as Src },
        options: { idempotencyKey: await idempotencyKeys.create(`reply-reply:inst:${r.id}`, { scope: "global" }), idempotencyKeyTTL: IDEMPOTENCY_TTL },
      }))
    );
    await processReply.batchTrigger(items);
    return { found: found.length, mode: mode("instantly") };
  },
});

export const scanPlusvibeReplies = schedules.task({
  id: "reply-scan-plusvibe",
  cron: "* * * * *", // same every-minute scan as Bison, on PlusVibe's unibox
  run: async () => {
    if (!process.env.PLUSVIBE_API_KEY) return { skipped: "plusvibe not used" };
    if (!C.configured) throw new Error("src/client.ts is still the template. Fill it in from the client onboarding (see CLAUDE.md) and set configured: true.");
    const missing = ["PLUSVIBE_API_KEY", "OPENROUTER_API_KEY", "SLACK_WEBHOOK_URL", "BOOKING_LINK"]
      .filter((k) => !process.env[k]);
    if (missing.length) {
      logger.warn(`not configured: ${missing.join(", ")} - PlusVibe scan skipped, nothing consumed`);
      return { skipped: "not_configured", missing };
    }
    const found = await pvRecentReplies(Date.now() - LOOKBACK_HOURS * 3600 * 1000, MAX_SCAN_PAGES);
    logger.info(`found ${found.length} PlusVibe campaign replies in the last ${LOOKBACK_HOURS}h`, { mode: mode("plusvibe") });
    if (!found.length) return { found: 0 };
    const items = await Promise.all(
      found.map(async (r) => ({
        payload: { replyId: r.id, src: "plusvibe" as Src },
        options: { idempotencyKey: await idempotencyKeys.create(`reply-reply:pv:${r.id}`, { scope: "global" }), idempotencyKeyTTL: IDEMPOTENCY_TTL },
      }))
    );
    await processReply.batchTrigger(items);
    return { found: found.length, mode: mode("plusvibe") };
  },
});


// Free-text replies: for replies the ready-made answers don't cover, the model writes from knowledge.md.
// FREE_TEXT=off turns this off and everything outside the approved answers goes to a person again.
const WRITE_CATEGORIES = new Set(["interested", "question", "other"]);
async function llm(system: string, user: string, maxTokens = 1500): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENROUTER_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.MODEL || DEFAULT_MODEL, temperature: 0, max_tokens: maxTokens,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json())?.choices?.[0]?.message?.content ?? "";
}

/** A full reply written from the knowledge base, or null (then a person answers). Never throws. */
export async function writeReply(p: {
  replyText: string; thread: string; company: string; firstName: string; slotLabels: string[]; link: string; sender: string; category?: string;
}): Promise<{ message: string | null; why: string }> {
  if (process.env.FREE_TEXT === "off") return { message: null, why: "free text is off" };
  if (!WRITE_CATEGORIES.has(p.category ?? "other")) return { message: null, why: `category ${p.category}` };
  try {
    const user = [`Lead company: ${p.company}`, "", "Their reply (newest message only):", p.replyText || "(empty)", p.thread ? `\nEarlier messages in this thread:\n${p.thread}` : ""].join("\n");
    const w = parseWritten(await llm(WRITER_PROMPT, user, 3000));
    if (w.handoff || !w.body) return { message: null, why: w.reason || "writer handed off" };
    const rule = hardRules(w.body);
    if (rule) return { message: null, why: `failed a fixed rule: ${rule}` };
    const g = parseGuard(await llm(GUARD_PROMPT, `${KNOWLEDGE}\n\n## Lead's message\n${p.replyText}\n\n## Draft reply\n${w.body}`, 2000));
    if (!g.ok) return { message: null, why: `checker said no: ${g.problem}` };
    return { message: assemble({ firstName: p.firstName, body: w.body, includeTimes: w.include_times !== false, slotLabels: p.slotLabels, link: p.link, sender: p.sender }), why: "written from the knowledge base" };
  } catch (e) {
    return { message: null, why: `writer error: ${String(e).slice(0, 120)}` };
  }
}

async function decide(r: BisonReply, thread: string): Promise<Decision> {
  const lead = r.lead ?? {};
  const user = [
    `Lead first name on record: ${lead.first_name ?? ""}`,
    `Lead company: ${lead.company ?? ""}`,
    `Reply subject: ${r.subject ?? ""}`,
    "",
    "Their reply (newest message only):",
    latestMessage(r.text_body ?? "") || "(empty)",
    "",
    "Full reply including quoted thread:",
    (r.text_body ?? "").slice(0, 6000),
    thread ? `\nEarlier messages in this thread:\n${thread}` : "",
  ].join("\n");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENROUTER_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.MODEL || DEFAULT_MODEL,
      temperature: 0,
      max_tokens: 2000,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return parseDecision(j?.choices?.[0]?.message?.content ?? "");
}

async function decideFollowUp(r: BisonReply, ours: string): Promise<FollowUp> {
  const lead = r.lead ?? {};
  const user = [
    `Lead first name on record: ${lead.first_name ?? ""}`,
    `Lead company: ${lead.company ?? ""}`,
    `Today: ${new Date().toISOString().slice(0, 10)}`,
    "",
    "Our last message to them:",
    ours || "(empty)",
    "",
    "Their newest reply:",
    latestMessage(r.text_body ?? "") || "(empty)",
  ].join("\n");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env("OPENROUTER_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: process.env.MODEL || DEFAULT_MODEL,
      temperature: 0,
      max_tokens: 2000,
      messages: [{ role: "system", content: FOLLOWUP_PROMPT }, { role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  return parseFollowUp(j?.choices?.[0]?.message?.content ?? "");
}

// Show what the lead was sent so the owner can prep for the call. First email only, not the whole thread.
const ANGLE: Record<string, string> = Object.fromEntries(Object.entries(C.offers).map(([k, v]) => [k, v.angle]));
interface FirstEmail { angle: string; campaign: string; subject: string; text: string }
const htmlToText = (h: string) => h.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The first campaign email this lead actually got (variables filled in), from Bison. Null if not found. */
export async function firstEmail(r: BisonReply): Promise<FirstEmail | null> {
  if (srcOf(r) === "instantly") {
    try {
      const f = await instFirstEmail(r.lead?.email ?? r.from_email_address ?? "");
      if (!f) return null;
      const campaign = `Instantly | ${await instCampaignName(f.campaignId ?? String(r.campaign_id ?? ""))}`;
      return { angle: ANGLE[offerFor(campaign)] ?? C.offers.primary.angle, campaign, subject: f.subject, text: htmlToText(f.html) };
    } catch (e) {
      logger.warn(`Instantly first email lookup failed for ${r.from_email_address}`, { error: String(e) });
      return null;
    }
  }
  if (srcOf(r) === "plusvibe") {
    try {
      const f = await pvFirstEmail(r.lead?.email ?? r.from_email_address ?? "");
      if (!f) return null;
      const campaign = `PlusVibe | ${await pvCampaignName(f.campaignId ?? String(r.campaign_id ?? ""))}`;
      return { angle: ANGLE[offerFor(campaign)] ?? C.offers.primary.angle, campaign, subject: f.subject, text: htmlToText(f.html) };
    } catch (e) {
      logger.warn(`PlusVibe first email lookup failed for ${r.from_email_address}`, { error: String(e) });
      return null;
    }
  }
  const leadId = r.lead?.id;
  if (!leadId) return null;
  try {
    const sent: any[] = (await bison(`/leads/${leadId}/sent-emails`))?.data ?? [];
    const step1 = sent.filter((m) => !m.thread_reply && m.sent_at)
      .sort((a, b) => Number(b.campaign_id === r.campaign_id) - Number(a.campaign_id === r.campaign_id) || Date.parse(a.sent_at) - Date.parse(b.sent_at))[0];
    if (!step1) return null;
    let campaign = `Campaign ${step1.campaign_id ?? r.campaign_id}`;
    try { campaign = (await bison(`/campaigns/${step1.campaign_id ?? r.campaign_id}`))?.data?.name ?? campaign; } catch { /* keep id */ }
    return { angle: ANGLE[offerFor(campaign)] ?? C.offers.primary.angle, campaign, subject: step1.email_subject ?? "", text: htmlToText(step1.email_body ?? "") };
  } catch (e) {
    logger.warn(`first email lookup failed for lead ${leadId}`, { error: String(e) });
    return null;
  }
}

function noteHtml(f: FirstEmail, replyText: string) {
  return `<p><strong>${C.name} outreach: ${esc(f.angle)}</strong> (${esc(f.campaign)})</p>`
    + `<p><strong>First email they got</strong><br>Subject: ${esc(f.subject)}</p><p>${esc(f.text).replace(/\n/g, "<br>")}</p>`
    + (replyText ? `<p><strong>Their reply</strong><br>${esc(replyText.slice(0, 1500)).replace(/\n/g, "<br>")}</p>` : "");
}

/** Put the lead in the owner's HubSpot (contact + deal). Best effort: logs and posts a Slack note on failure, never throws. */
async function crm(kind: "new" | "booked", r: BisonReply, firstName: string) {
  if (mode(srcOf(r)) !== "send" || !process.env.HUBSPOT_TOKEN) return;
  const lead = r.lead ?? {};
  const email = r.from_email_address ?? lead.email ?? "";
  if (!email) return;
  const p = {
    email, firstName, lastName: (lead.last_name ?? "").replace(/^-$/, ""), company: lead.company ?? "", title: lead.title ?? "",
  };
  try {
    const out = kind === "new" ? await addLead(p) : await markBooked(p);
    logger.info(`HubSpot ${kind}: ${email}`, out);
    // One note per lead: when they first come in as a positive, or when a booking creates the deal.
    if (kind === "new" || out.created) {
      const f = await firstEmail(r);
      if (f) await addNote(out.contactId, out.dealId, noteHtml(f, latestMessage(r.text_body ?? "")));
    }
  } catch (e) {
    logger.error(`HubSpot ${kind} failed: ${email}`, { error: String(e) });
    try { await slackNote(`:warning: Couldn't update HubSpot for ${email} (${kind === "new" ? "new lead" : "call booked"}). Add it by hand. ${String(e).slice(0, 150)}`); } catch { /* ignore */ }
  }
}

const SENDER_CACHE = new Map<number, { first: string; email: string }>();
export async function sender(r: BisonReply): Promise<{ first: string; email: string }> {
  if (isExternal(srcOf(r))) {
    const first = String(r.eaccount_first || (srcOf(r) === "instantly" ? await instAccountFirst(r.eaccount ?? "") : "")).trim().split(/\s+/)[0] ?? "";
    return { first, email: r.eaccount ?? "" };
  }
  const id = r.sender_email_id ?? null;
  if (!id) return { first: "", email: "" };
  if (SENDER_CACHE.has(id)) return SENDER_CACHE.get(id)!;
  try {
    const d = (await bison(`/sender-emails/${id}`))?.data ?? {};
    const s = { first: String(d.name ?? "").trim().split(/\s+/)[0] ?? "", email: d.email ?? "" };
    SENDER_CACHE.set(id, s);
    return s;
  } catch {
    return { first: "", email: "" };
  }
}

type AlertKind = "positive" | "referral" | "followup" | "booked";
const HEADERS: Record<AlertKind, [string, string]> = {
  positive: [`:fire: Positive reply - ${C.name}`, "Positive reply"],
  referral: [`:handshake: Referral - ${C.name}`, "Referral"],
  followup: [`:speech_balloon: Follow-up reply - ${C.name}`, "Follow-up reply"],
  booked: [`:calendar: Call booked - ${C.name}`, "Call booked"],
};

type AlertInput = {
  kind: AlertKind; campaign: string; name: string; email: string; company: string; title: string;
  replyText: string; outcome: string; message: string | null; reason: string; sent?: FirstEmail | null;
  link?: string; // Bison thread for this lead, so a person can open it in one click
};

/** The Slack card itself, kept apart from the post so a test can render it without sending. */
export function slackCard(p: AlertInput) {
  const [header, short] = HEADERS[p.kind];
  const blocks: any[] = [
    { type: "header", text: { type: "plain_text", text: header, emoji: true } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Campaign*\n${p.campaign}` },
        { type: "mrkdwn", text: `*Name*\n${p.name || "-"}` },
        { type: "mrkdwn", text: `*Email*\n${p.email || "-"}` },
        { type: "mrkdwn", text: `*Brand*\n${p.company || "-"}` },
        { type: "mrkdwn", text: `*Title*\n${p.title || "-"}` },
      ],
    },
  ];
  // The owner preps from the first email, so it sits right under the lead details, in full (Slack caps a section at 3,000 characters)
  if (p.sent) blocks.push({ type: "section", text: { type: "mrkdwn",
    text: `*First email they got (${p.sent.angle})*\n>*Subject: ${p.sent.subject}*\n>\n>${p.sent.text.slice(0, 2800).replace(/\n/g, "\n>")}` } });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Their reply*\n>${(p.replyText || "(no text)").slice(0, 1500).replace(/\n/g, "\n>")}` } });
  if (p.message) blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${p.outcome}*\n>${p.message.replace(/\n/g, "\n>")}` } });
  else blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: p.outcome }] });
  if (p.reason) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Note: ${p.reason}` }] });
  if (p.link) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${p.link}|Open the thread in Email Bison>` }] });
  const tag = p.kind === "booked" && process.env.SLACK_OWNER_USER_ID ? `<@${process.env.SLACK_OWNER_USER_ID}> ` : "";
  if (tag) blocks.splice(1, 0, { type: "section", text: { type: "mrkdwn", text: `${tag}a call was just booked.` } });
  return { text: `${tag}${short} from ${p.name} at ${p.company || "unknown brand"}`, blocks };
}

// Slack reply bridge: with SLACK_BOT_TOKEN, cards are posted by the bot with the lead's reply id
// attached, so a person can answer in the card's Slack thread and the agent sends it to the lead.
const SLACK_CHANNEL = () => env("SLACK_CHANNEL_ID"); // the channel cards are posted to
let CARD_REF: { id: Id; src: Src; uuid?: string | null } | null = null; // the lead reply this run is about; set where a run starts

async function slackApi(method: string, body: unknown) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("SLACK_BOT_TOKEN")}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const j: any = await res.json();
  if (!j.ok) throw new Error(`Slack ${method}: ${j.error}`);
  return j;
}

async function slack(p: AlertInput) {
  const link = CARD_REF?.src === "bison" && CARD_REF?.uuid ? `${BISON_UI}/inbox/replies/${CARD_REF.uuid}` : undefined;
  const card = slackCard({ ...p, link: p.link ?? link });
  if (process.env.SLACK_BOT_TOKEN && CARD_REF) {
    try {
      await slackApi("chat.postMessage", {
        channel: SLACK_CHANNEL(), text: card.text, blocks: card.blocks, unfurl_links: false,
        metadata: { event_type: "reply_card", event_payload: { id: String(CARD_REF.id), src: CARD_REF.src } },
      });
      return;
    } catch (e) { logger.warn(`bot post failed, using webhook: ${String(e).slice(0, 150)}`); }
  }
  const res = await fetch(env("SLACK_WEBHOOK_URL"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  });
  if (!res.ok) throw new Error(`Slack ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** One in-thread reply to the person who replied (or, for a referral, to the address they gave). No cc. Keyed per lead AND turn by the caller, so two
 *  replies from the same lead can never get the same agent message twice. */
export const sendBisonTask = task({
  id: "reply-send-reply",
  retry: { maxAttempts: 3 },
  run: async (p: { replyId: number; senderEmailId: number; toName: string | null; toEmail: string; message: string; asPerson?: boolean }) => {
    const body = replyBody({ message: p.message, senderEmailId: p.senderEmailId, to: { name: p.toName, email: p.toEmail }, cc: [], asPerson: p.asPerson });
    const out = await bison(`/replies/${p.replyId}/reply`, { method: "POST", body });
    return { sentReplyId: out?.data?.reply?.id ?? out?.data?.id ?? null };
  },
});

export const processReply = task({
  id: "reply-process-reply",
  retry: { maxAttempts: 3 },
  run: async ({ replyId, src = "bison" }: { replyId: Id; src?: Src }) => {
    const t = await getThread(src, replyId);
    const r = t.current_reply as BisonReply;
    if (!r) throw new Error(`reply ${replyId} not found`);
    if (isBounce(r)) return { replyId, skipped: "bounce" };
    CARD_REF = { id: replyId, src, uuid: r.uuid };
    const lead = r.lead ?? {};
    const name = [lead.first_name, lead.last_name].filter((x) => x && x !== "-" && x.toLowerCase() !== "there").join(" ")
      || r.from_name || "Unknown";

    const older: BisonReply[] = t.older_messages ?? [];
    // A person may have written in this thread (Slack or by hand). The agent keeps handling the lead's newer replies anyway.
    // The agent has already answered this lead in this thread -> this is a follow-up turn (book / new times / person).
    const agentMsgs = older.filter((m) => isSent(m) && isAgentMessage(m));
    if (agentMsgs.length) return followUp(t, r, name, agentMsgs);

    // Someone already answered after this reply -> never auto-send.
    const alreadyHandled = answeredInThread(t);
    const thread = older.slice(-4)
      .map((m) => `[${m.folder ?? ""} ${m.date_received ?? ""}] ${latestMessage(m.text_body ?? "").slice(0, 800)}`).join("\n\n");

    // Bison's AI classification is off: the agent decides every reply itself, auto-replies included.
    const d: Decision = await decide(r, thread);
    const positive = d.action !== "human" || (d.action === "human" && HANDOFF_CATEGORIES.has(d.category ?? ""));
    const replyText = latestMessage(r.text_body ?? "");
    // A referral never gets the "owner will get back to you" holding reply and never makes a HubSpot deal:
    // the person who answered is not the buyer. We email the address they gave us instead.
    if (d.action === "human" && d.category === "referral") return referral(t, r, name, d, replyText);
    if (!positive) {
      logger.info(`no action (${d.category}): ${name}`, { replyText, reason: d.reason });
      return { replyId, decision: d, status: "no_action" };
    }

    const campaign = await campaignName(r);
    const from = await sender(r);
    const firstName = cleanFirstName(d.first_name, lead.first_name);
    await crm("new", r, firstName); // every positive reply goes into the owner's HubSpot pipeline
    // They named their own day and time: run the book-it flow (same as a follow-up turn, with no earlier agent message).
    if (d.action === "time") return followUp(t, r, name, []);
    let written: string | null = null;
    if (d.action === "human") {
      const wslots = await suggestSlots(env("BOOKING_LINK"));
      const w = await writeReply({
        replyText, thread, company: lead.company ?? "", firstName, slotLabels: wslots.map((x) => x.label),
        link: env("BOOKING_LINK"), sender: from.first || "", category: d.category,
      });
      written = w.message;
      if (written) d.reason = `${w.why}. ${d.reason ?? ""}`.trim();
      else d.reason = `${d.reason ?? ""} (no free-text reply: ${w.why})`.trim();
    }
    if (d.action === "human" && !written) {
      // Anything outside the approved answers: no holding reply, Slack says a person must answer in the thread.
      await slack({
        kind: "positive", campaign, name, email: lead.email ?? r.from_email_address ?? "", company: lead.company ?? "", title: lead.title ?? "",
        replyText, message: null, outcome: "No auto-reply - this needs an answer in the thread.", reason: d.reason ?? "",
      });
      return { replyId, decision: d, status: "needs_answer" };
    }
    // The booking link is only used to read the owner's calendar. It is never put in the email.
    const slots = await suggestSlots(env("BOOKING_LINK"));
    if (!slots.length) logger.warn("calendar gave no slots - asking for a time instead");
    const labels = slots.map((s) => s.label);
    const message = written ? written : d.action === "answer" && d.topic
      ? answerMessage(d.topic, firstName, labels, from.first || C.owner.first, env("BOOKING_LINK"))
      : templateMessage(firstName, offerFor(campaign), labels, from.first || C.owner.first, env("BOOKING_LINK"));
    const toEmail = r.from_email_address ?? lead.email ?? "";
    const toName = r.from_name ?? name;

    let status: string;
    let outcome: string;
    let shown: string | null = message;
    if (alreadyHandled) {
      status = "already_handled"; outcome = "Already answered in this thread - no auto-reply."; shown = null;
    } else if (mode(srcOf(r)) !== "send") {
      status = "shadow"; outcome = "Would reply (test mode, nothing sent):";
    } else if (!from.first) {
      status = "not_sent_sender_name"; outcome = "Not auto-replied: couldn't read the sending inbox's name for the sign-off. Reply by hand."; shown = null;
    } else if (!lead.id || !canSend(r) || !toEmail) {
      status = "not_sent_missing_data"; outcome = "Not auto-replied: missing lead, sender or recipient. Reply by hand."; shown = null;
    } else {
      // Give a person time to answer by hand first. Alert now, wait out the grace period, re-read the thread,
      // and only auto-reply if nobody has answered in it.
      const sendAt = new Date(r.date_received).getTime() + graceMinutes() * 60_000;
      const waitSec = Math.ceil((sendAt - Date.now()) / 1000);
      const alertBase = {
        kind: (d.category === "referral" ? "referral" : "positive") as "referral" | "positive",
        campaign, name, email: lead.email ?? r.from_email_address ?? "", company: lead.company ?? "", title: lead.title ?? "",
        replyText, reason: d.reason ?? "",
      };
      if (waitSec > 5) {
        await slack({ ...alertBase, message, outcome: `Auto-reply goes out around ${etTime(sendAt)} ET unless someone answers in the thread first (signed ${from.first}):` });
        await wait.for({ seconds: waitSec });
      }
      const fresh = await getThread(srcOf(r), replyId);
      if (answeredInThread(fresh)) {
        if (waitSec > 5) await slackNote(`:white_check_mark: ${name} (${lead.company || "unknown brand"}) was answered by hand - auto-reply cancelled.`);
        else await slack({ ...alertBase, message: null, outcome: "Already answered in this thread - no auto-reply." });
        logger.info(`manual reply found before send: ${name}`, { campaign });
        return { replyId, decision: d, status: "manual_reply_first" };
      }
      const res = await sendReply(r, { toName, toEmail, message }, `reply-send-lead:${lead.id}`); // turn 1
      if (!res.ok) throw new Error(`send failed for reply ${r.id}`);
      // Nudge only a plain yes that went quiet. A lead who asked a question or set a condition got an answer (or the free-text
      // reply), and a bump asking for a time would ignore what they said. A person decides any follow-up for those.
      if (d.action === "send" && !written) await scheduleNudge(r, 1, Date.now(), Date.now());
      if (waitSec > 5) await slackNote(`:outbox_tray: Auto-reply sent to ${name} (${lead.company || "unknown brand"}) from ${from.email}.`);
      else await slack({ ...alertBase, message, outcome: `Auto-replied from ${from.email} (signed ${from.first}):` });
      logger.info(`sent: ${name} <${toEmail}>`, { campaign, replyText, message, reason: d.reason });
      // They said yes AND named someone to bring in: email that person too.
      if (d.referral_email) await referral(t, r, name, d, replyText, true);
      return { replyId, decision: d, status: "sent" };
    }

    await slack({
      kind: d.category === "referral" ? "referral" : "positive",
      campaign, name, email: lead.email ?? r.from_email_address ?? "", company: lead.company ?? "", title: lead.title ?? "",
      replyText, outcome, message: shown, reason: d.reason ?? "",
    });
    logger.info(`${status}: ${name} <${toEmail}>`, { campaign, replyText, message, reason: d.reason });
    if (status === "shadow" && d.referral_email) await referral(t, r, name, d, replyText, true);
    return { replyId, decision: d, status };
  },
});

/** A lead pointed us to another address ("send proposals to business@brand.com"). Email that address with the same offer.
 *  No holding reply to the person who answered, no HubSpot deal. Needs REFERRALS=send (and MODE=send) to actually
 *  send; otherwise Slack shows the draft. Same grace period as every other auto-reply. */
async function referral(t: Thread, r: BisonReply, name: string, d: Decision, replyText: string, alsoReplied = false) {
  const replyId = r.id;
  const lead = r.lead ?? {};
  const campaign = await campaignName(r);
  const from = await sender(r);
  const leadEmail = r.from_email_address ?? lead.email ?? "";
  const base = {
    kind: "referral" as const, campaign, name, email: leadEmail, company: lead.company ?? "", title: lead.title ?? "",
    replyText, reason: d.reason ?? "",
  };
  const to = validReferralEmail(d.referral_email, { leadEmail, ownDomains: [from.email.split("@")[1] ?? "", ...C.ownDomains] });
  if (!to) {
    await slack({ ...base, message: null, outcome: "Referral, but the reply has no single usable address. Not emailed. Reply by hand." });
    return { replyId, decision: d, status: "referral_no_address" };
  }
  if (!alsoReplied && answeredInThread(t)) {
    await slack({ ...base, message: null, outcome: `Referral to ${to}. Already answered in this thread - not emailed.` });
    return { replyId, decision: d, status: "referral_already_handled" };
  }
  const message = referralMessage({ toFirst: cleanFirstName(d.referral_name), brand: lead.company ?? "", offer: "primary", sender: from.first || C.owner.first }); // referral emails always pitch the primary offer
  if (mode(srcOf(r)) !== "send" || process.env.REFERRALS !== "send" || srcOf(r) === "instantly") {
    // Instantly can only answer the original sender, so a referral email is always a Slack draft for a person to send.
    await slack({ ...base, message, outcome: `Referral. Would email ${to} (draft, nothing sent${srcOf(r) === "instantly" ? ", send it by hand from Instantly" : ""}):` });
    return { replyId, decision: d, status: "referral_shadow", to };
  }
  if (!from.first || !lead.id || !canSend(r)) {
    await slack({ ...base, message: null, outcome: `Referral to ${to}. Not emailed: missing sender name, lead or sender. Email by hand.` });
    return { replyId, decision: d, status: "referral_missing_data", to };
  }
  const sendAt = new Date(r.date_received).getTime() + graceMinutes() * 60_000;
  const waitSec = Math.ceil((sendAt - Date.now()) / 1000);
  if (waitSec > 5) {
    await slack({ ...base, message, outcome: `Referral. Emails ${to} around ${etTime(sendAt)} ET unless someone answers in the thread first (signed ${from.first}):` });
    await wait.for({ seconds: waitSec });
  }
  const fresh = await getThread(srcOf(r), replyId);
  if (!alsoReplied && answeredInThread(fresh)) {
    await slackNote(`:white_check_mark: Referral from ${name} (${lead.company || "unknown brand"}) was answered by hand - email to ${to} cancelled.`);
    return { replyId, decision: d, status: "referral_manual_first", to };
  }
  const res = await sendReply(r, { toName: null, toEmail: to, message }, `reply-referral:${lead.id}`);
  if (!res.ok) throw new Error(`referral send failed for reply ${r.id}`);
  if (waitSec > 5) await slackNote(`:outbox_tray: Referral email sent to ${to} (${lead.company || "unknown brand"}) from ${from.email}.`);
  else await slack({ ...base, message, outcome: `Emailed ${to} from ${from.email} (signed ${from.first}):` });
  return { replyId, decision: d, status: "referral_sent", to };
}

/** A lead answered one of the agent's messages. Book the time they picked, offer new times, or hand to a person.
 *  Same grace period as the first reply: alert, wait, re-read the thread, and act only if nobody answered by hand. */
async function followUp(t: Thread & { current_reply?: BisonReply }, r: BisonReply, name: string, agentMsgs: BisonReply[]) {
  const replyId = r.id;
  const lead = r.lead ?? {};
  const replyText = latestMessage(r.text_body ?? "");
  const campaign = await campaignName(r);
  const base = { campaign, name, email: lead.email ?? r.from_email_address ?? "", company: lead.company ?? "", title: lead.title ?? "", replyText };
  const toPerson = async (reason: string) => {
    await slack({ ...base, kind: "followup", message: null, outcome: "No auto-reply - needs a person to answer in the thread.", reason });
    return { replyId, status: "followup_human", reason };
  };

  if ((t.newer_messages ?? []).length) return { replyId, status: "followup_superseded" }; // a later message exists
  if (agentMsgs.length >= MAX_AGENT_TURNS) return toPerson(`agent has already sent ${agentMsgs.length} messages in this thread`);

  const lastOurs = agentMsgs.length ? latestMessage(agentMsgs[agentMsgs.length - 1].text_body ?? "") : "";
  const f = await decideFollowUp(r, lastOurs);
  // They may have booked through the HubSpot link before writing back ("all set for 3pm").
  // Check first, so we never offer new times for a call that's already on the owner's calendar.
  const firstSentAt = agentMsgs.length ? Date.parse(agentMsgs[0].date_received) : NaN;
  if (agentMsgs.length && await bookedSince(r.from_email_address ?? lead.email ?? "", firstSentAt)) {
    await linkBooked(r, replyText);
    if (f.action === "ack" || f.action === "book") return { replyId, status: "booked_via_link" };
    return toPerson("They booked through the HubSpot link, but their reply also needs an answer.");
  }
  if (f.action === "ack") return { replyId, status: "followup_ack" }; // a bare thank-you: no reply, no alert
  let composed: string | null = null;
  if (f.action === "human") {
    if (/auto|office|ooo/i.test(f.category ?? "")) return { replyId, status: "followup_automated" };
    const wFrom = await sender(r);
    const wLink = env("BOOKING_LINK");
    const wSlots = wFrom.first ? await suggestSlots(wLink) : [];
    const w = await writeReply({
      replyText, thread: lastOurs ? `[Our last message] ${lastOurs.slice(0, 800)}` : "", company: lead.company ?? "",
      firstName: cleanFirstName(f.first_name, lead.first_name), slotLabels: wSlots.map((x) => x.label), link: wLink, sender: wFrom.first, category: f.category,
    });
    if (!w.message || !wFrom.first) return toPerson(`${f.reason || f.category || ""} (no free-text reply: ${w.why})`);
    composed = w.message;
    f.reason = `${w.why}. ${f.reason ?? ""}`.trim();
  }

  const from = await sender(r);
  const toEmail = r.from_email_address ?? lead.email ?? "";
  if (!from.first || !lead.id || !canSend(r) || !toEmail) return toPerson("missing sender name, lead, sender or recipient");
  const firstName = cleanFirstName(f.first_name, lead.first_name);
  const link = env("BOOKING_LINK");

  // Work out what we'd do, before the grace wait.
  let bookAt: number | null = null;
  let message: string;
  let a = null as Awaited<ReturnType<typeof availability>>;
  if (composed) {
    message = composed;
  } else if (f.action === "book") {
    a = await availability(link);
    if (!a) return toPerson(`wants ${f.slot ?? f.time} but the calendar isn't connected (no HubSpot token) - book it by hand`);
    bookAt = matchSlot(a, f);
    if (bookAt) message = confirmMessage(firstName, label(new Date(bookAt)), from.first);
    else {
      const offered = new Set(offeredSlots(lastOurs).map((l) => l.split(" at ")[0]));
      const slots = await suggestSlots(link, offered);
      message = newTimesMessage(firstName, slots.map((s) => s.label), from.first, link, true);
    }
  } else if (f.action === "answer" && f.topic) {
    const slots = await suggestSlots(link);
    message = answerMessage(f.topic, firstName, slots.map((s) => s.label), from.first, link);
  } else {
    const offered = new Set(offeredSlots(lastOurs).map((l) => l.split(" at ")[0]));
    const slots = await suggestSlots(link, offered);
    message = newTimesMessage(firstName, slots.map((s) => s.label), from.first, link);
  }

  if (mode(srcOf(r)) !== "send") {
    await slack({ ...base, kind: "followup", message, outcome: `Would ${bookAt ? `book ${label(new Date(bookAt))} and ` : ""}reply (test mode, nothing sent):`, reason: f.reason ?? "" });
    return { replyId, status: "followup_shadow", f };
  }

  const sendAt = new Date(r.date_received).getTime() + graceMinutes() * 60_000;
  const waitSec = Math.ceil((sendAt - Date.now()) / 1000);
  if (waitSec > 5) {
    const what = bookAt ? `Books ${label(new Date(bookAt))} and replies` : "Auto-reply goes out";
    await slack({ ...base, kind: "followup", message, outcome: `${what} around ${etTime(sendAt)} ET unless someone answers in the thread first (signed ${from.first}):`, reason: "" });
    await wait.for({ seconds: waitSec });
  }
  const fresh = await getThread(srcOf(r), replyId);
  if (answeredInThread(fresh)) {
    await slackNote(`:white_check_mark: ${name} (${lead.company || "unknown brand"}) was answered by hand - auto-reply cancelled.`);
    return { replyId, status: "followup_manual_first" };
  }

  if (bookAt && a) {
    // Re-check the slot is still free right before booking.
    const now = await availability(link);
    if (!now || !now.starts.includes(bookAt)) return toPerson(`${label(new Date(bookAt))} was taken before we could book it`);
    const b = await bookSlot({ a: now, startMs: bookAt, email: toEmail, firstName, lastName: (lead.last_name ?? "").replace(/^-$/, ""), guestEmails: [] });
    if (!b.ok) return toPerson(`booking ${label(new Date(bookAt))} failed: ${b.error}`);
    await crm("booked", r, firstName);
  }

  const turn = agentMsgs.length + 1;
  const res = await sendReply(r, { toName: r.from_name ?? name, toEmail, message }, `reply-send-lead:${lead.id}:turn${turn}`);
  if (!res.ok) throw new Error(`send failed for reply ${r.id}`);
  if (!bookAt && f.action !== "answer") await scheduleNudge(r, 1, Date.now(), Date.now()); // an answered question gets no bump either
  if (bookAt) {
    await slack({ ...base, kind: "booked", message, outcome: `Booked ${label(new Date(bookAt))} on the owner's calendar and replied from ${from.email}:`, reason: "", sent: await firstEmail(r) });
  } else if (waitSec <= 5) {
    await slack({ ...base, kind: "followup", message, outcome: `Sent new times from ${from.email} (signed ${from.first}):`, reason: "" });
  } else {
    await slackNote(`:outbox_tray: Sent new times to ${name} (${lead.company || "unknown brand"}) from ${from.email}.`);
  }
  logger.info(`follow-up ${bookAt ? "booked" : "new times"}: ${name}`, { campaign, replyText, message });
  return { replyId, status: bookAt ? "booked" : "new_times_sent", f };
}

// ---------------------------------------------------------------------------------------------------------------
// Nudges: a lead said yes, got our times or link, then went quiet. Nudge 1 24 hours after our reply, nudge 2 48 hours
// after nudge 1, weekends included. Max 2, no breakup. Stops if they reply, a person writes in the thread, or they
// booked (checked on HubSpot once the owner's token is in). Slack heads-up first; replying in the thread stops it.
const NUDGE_DAYS: Record<1 | 2, number> = { 1: 1, 2: 2 };
const nudgeNoticeMinutes = () => Number(process.env.NUDGE_NOTICE_MINUTES ?? 60);
const nudgesOn = (src: Src = "bison") => process.env.NUDGES !== "off" && mode(src) === "send";

/** replyId = the lead's reply we answered. firstSentAt = when we first answered it (bookings after this count). */
async function scheduleNudge(r: BisonReply, n: 1 | 2, fromMs: number, firstSentAt: number) {
  const replyId = r.id, src = srcOf(r);
  if (!nudgesOn(src) || !r.lead?.id) return;
  const at = new Date(nudgeTime(fromMs, NUDGE_DAYS[n]));
  await nudgeLead.trigger(
    { replyId, n, firstSentAt, src },
    { delay: at, idempotencyKey: await idempotencyKeys.create(`reply-nudge:${replyId}:${n}`, { scope: "global" }), idempotencyKeyTTL: "30d" }
  );
  logger.info(`nudge ${n} scheduled for reply ${replyId} at ${at.toISOString()}`);
  if (n === 1) await watchBooking.trigger(
    { replyId, firstSentAt, src },
    { idempotencyKey: await idempotencyKeys.create(`reply-watch:${replyId}`, { scope: "global" }), idempotencyKeyTTL: "30d" }
  );
}

/** Everything after the lead's reply is still only our agent messages, exactly `expected` of them. */
function stillQuiet(t: Thread, expected: number): boolean {
  const newer = t.newer_messages ?? [];
  return newer.length === expected && newer.every((m) => isSent(m) && isAgentMessage(m)) && !personInThread(t.older_messages ?? []);
}

export const nudgeLead = task({
  id: "reply-nudge-lead",
  retry: { maxAttempts: 3 },
  run: async ({ replyId, n, firstSentAt, src = "bison" }: { replyId: Id; n: 1 | 2; firstSentAt: number; src?: Src }) => {
    if (!nudgesOn(src)) return { replyId, n, status: "nudges_off" };
    const dayAt = rollOffWeekend(Date.now()); // no follow-ups over the weekend: a nudge due Sat or Sun waits for Monday 9:00 AM ET
    if (dayAt > Date.now()) await wait.until({ date: new Date(dayAt) });
    const t = await getThread(src, replyId);
    const r = t.current_reply as BisonReply;
    if (!r) return { replyId, n, status: "reply_gone" };
    CARD_REF = { id: replyId, src, uuid: r.uuid };
    if (!stillQuiet(t, n)) return { replyId, n, status: "not_quiet" }; // they replied, or a person stepped in
    const lead = r.lead ?? {};
    const toEmail = r.from_email_address ?? lead.email ?? "";
    const booked = await bookedSince(toEmail, firstSentAt);
    if (booked) {
      await linkBooked(r, latestMessage(r.text_body ?? ""));
      return { replyId, n, status: "booked" };
    }
    const from = await sender(r);
    if (!from.first || !lead.id || !canSend(r) || !toEmail) return { replyId, n, status: "missing_data" };
    const campaign = await campaignName(r);
    const link = env("BOOKING_LINK");
    const slots = n === 1 ? await suggestSlots(link) : [];
    const firstName = cleanFirstName(lead.first_name, r.from_name);
    const message = nudgeMessage(n, firstName, offerFor(campaign), slots.map((s) => s.label), from.first, link);
    const name = [lead.first_name, lead.last_name].filter((x) => x && x !== "-" && x.toLowerCase() !== "there").join(" ") || r.from_name || toEmail;

    const sendAt = Date.now() + nudgeNoticeMinutes() * 60_000;
    const bookNote = booked === null ? " Can't check HubSpot for bookings yet - if they've already booked, reply in the thread (e.g. \"See you then\") to stop it." : "";
    await slack({
      kind: "followup", campaign, name, email: toEmail, company: lead.company ?? "", title: lead.title ?? "",
      replyText: latestMessage(r.text_body ?? ""), message,
      outcome: `No reply or booking yet. Nudge ${n} of 2 goes out around ${etTime(sendAt)} ET unless someone answers in the thread first (signed ${from.first}):`,
      reason: bookNote.trim(),
    });
    await wait.for({ seconds: nudgeNoticeMinutes() * 60 });
    const afterAt = rollOffWeekend(Date.now()); // the notice wait can cross into Saturday
    if (afterAt > Date.now()) await wait.until({ date: new Date(afterAt) });

    const fresh = await getThread(srcOf(r), replyId);
    if (!stillQuiet(fresh, n) || (await bookedSince(toEmail, firstSentAt))) {
      await slackNote(`:white_check_mark: Nudge ${n} to ${name} cancelled - the thread moved or they booked.`);
      return { replyId, n, status: "cancelled" };
    }
    const res = await sendReply(r, { toName: r.from_name ?? name, toEmail, message }, `reply-nudge-send:${replyId}:${n}`);
    if (!res.ok) throw new Error(`nudge ${n} send failed for reply ${replyId}`);
    await slackNote(`:outbox_tray: Nudge ${n} sent to ${name} (${lead.company || "unknown brand"}) from ${from.email}.`);
    if (n === 1) await scheduleNudge(r, 2, Date.now(), firstSentAt);
    return { replyId, n, status: "sent" };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Link bookings: a lead books through the owner's HubSpot link instead of picking one of our times. Caught three ways (their
// next reply, the 10-minute watch below, the nudge), and announced once per lead: deal to the booked stage + booked card for the owner.
const WATCH_EVERY_MIN = 10;
const WATCH_HOURS = 72; // covers both nudges

async function linkBooked(r: BisonReply, replyText: string) {
  if (!r.lead?.id || mode(srcOf(r)) !== "send") return;
  await announceLinkBooking.triggerAndWait(
    { replyId: r.id, replyText, src: srcOf(r) },
    { idempotencyKey: await idempotencyKeys.create(`reply-link-booked:${r.lead.id}`, { scope: "global" }), idempotencyKeyTTL: "30d" }
  );
}

export const announceLinkBooking = task({
  id: "reply-link-booking",
  retry: { maxAttempts: 3 },
  run: async ({ replyId, replyText, src = "bison" }: { replyId: Id; replyText: string; src?: Src }) => {
    const r = (await getThread(src, replyId)).current_reply as BisonReply;
    if (!r) return { replyId, status: "reply_gone" };
    const lead = r.lead ?? {};
    const email = r.from_email_address ?? lead.email ?? "";
    await crm("booked", r, cleanFirstName(lead.first_name, r.from_name));
    const start = await nextMeetingStart(email);
    const campaign = await campaignName(r);
    const name = [lead.first_name, lead.last_name].filter((x) => x && x !== "-" && x.toLowerCase() !== "there").join(" ") || r.from_name || email;
    await slack({
      kind: "booked", campaign, name, email, company: lead.company ?? "", title: lead.title ?? "", replyText, message: null,
      outcome: `Booked ${start ? label(new Date(start)) : "a time"} through the owner's HubSpot link. Deal moved to the booked stage. No email sent (HubSpot sends the invite).`,
      reason: "", sent: await firstEmail(r),
    });
    return { replyId, status: "announced", start };
  },
});

/** After we send times: check HubSpot every 10 minutes, so a silent link booking reaches the owner before the call, not at the next nudge.
 *  Stops when they book, reply (the reply flow takes over), or a person writes in the thread. */
export const watchBooking = task({
  id: "reply-watch-booking",
  run: async ({ replyId, firstSentAt, src = "bison" }: { replyId: Id; firstSentAt: number; src?: Src }) => {
    const until = firstSentAt + WATCH_HOURS * 3600_000;
    while (Date.now() < until) {
      await wait.for({ minutes: WATCH_EVERY_MIN });
      const t = await getThread(src, replyId);
      const r = t.current_reply as BisonReply;
      if (!r) return { replyId, status: "reply_gone" };
      const quiet = (t.newer_messages ?? []).every((m: BisonReply) => isSent(m) && isAgentMessage(m)) && !personInThread(t.older_messages ?? []);
      if (!quiet) return { replyId, status: "thread_moved" };
      if (await bookedSince(r.from_email_address ?? r.lead?.email ?? "", firstSentAt)) {
        await linkBooked(r, latestMessage(r.text_body ?? ""));
        return { replyId, status: "booked" };
      }
    }
    return { replyId, status: "watch_ended" };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Reply from Slack. A person answers in a card's Slack thread; the agent sends that text to the lead from the
// inbox that got the reply, in the same thread. It carries the agent tag on purpose: the agent keeps
// monitoring the conversation and answers the lead's next reply, even after a person has answered from Slack. Only people in SLACK_REPLY_USERS (Slack user ids) can send.
const SLACK_REPLY_USERS = () => new Set((process.env.SLACK_REPLY_USERS || "").split(",").map((x) => x.trim()));

export const sendSlackReply = task({
  id: "reply-slack-reply",
  retry: { maxAttempts: 2 },
  run: async ({ id, src = "bison", text: raw, slackTs, replyTs, user }: { id: Id; src?: Src; text: string; slackTs: string; replyTs: string; user: string }) => {
    // Slack escapes & < > and wraps links as <url|label>
    const text = raw.replace(/<(https?:[^|>]+)\|[^>]*>/g, "$1").replace(/<(https?:[^>]+)>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const note = (msg: string) => slackApi("chat.postMessage", { channel: SLACK_CHANNEL(), thread_ts: slackTs, text: msg, unfurl_links: false });
    const t = await getThread(src, id);
    const r = t.current_reply as BisonReply;
    if (!r) { await note(":warning: Not sent: couldn't find that reply any more."); return { status: "reply_gone" }; }
    const lead = r.lead ?? {};
    const toEmail = r.from_email_address ?? lead.email ?? "";
    if (!canSend(r) || !toEmail) { await note(":warning: Not sent: missing the sending inbox or the lead's address. Reply in the sending tool."); return { status: "missing_data" }; }
    const from = await sender(r);
    const res = await sendReply(r, { toName: r.from_name ?? null, toEmail, message: text }, `reply-slack-reply:${replyTs}`);
    if (!res.ok) throw new Error(`slack reply send failed for ${id}`);
    await note(`:outbox_tray: Sent to ${toEmail} from ${from.email || "the sending inbox"}. The agent keeps watching this thread and will answer their next reply.`);
    return { status: "sent", to: toEmail, by: user };
  },
});

export const watchSlackReplies = schedules.task({
  id: "reply-watch-slack-replies",
  cron: "* * * * *",
  run: async () => {
    if (!process.env.SLACK_BOT_TOKEN) return { skipped: "no bot token" };
    const oldest = String((Date.now() - 48 * 3600_000) / 1000);
    const hist = await slackApi("conversations.history", { channel: SLACK_CHANNEL(), oldest, limit: 200, include_all_metadata: true });
    const allowed = SLACK_REPLY_USERS();
    let queued = 0;
    for (const m of hist.messages ?? []) {
      if (m.metadata?.event_type !== "reply_card" || !m.reply_count) continue;
      const { id, src } = m.metadata.event_payload ?? {};
      if (!id) continue;
      const th = await slackApi("conversations.replies", { channel: SLACK_CHANNEL(), ts: m.ts, limit: 100 });
      for (const rep of (th.messages ?? []).slice(1)) {
        if (rep.bot_id || rep.subtype || !rep.user || !allowed.has(rep.user)) continue;
        const text = String(rep.text ?? "").trim();
        if (!text) continue;
        const key = await idempotencyKeys.create(`reply-slack-reply:${rep.ts}`, { scope: "global" });
        await sendSlackReply.trigger({ id: src && src !== "bison" ? String(id) : Number(id), src, text, slackTs: m.ts, replyTs: rep.ts, user: rep.user }, { idempotencyKey: key, idempotencyKeyTTL: "7d" });
        queued++;
      }
    }
    return { queued };
  },
});
