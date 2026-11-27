// PlusVibe (optional second sending instance, e.g. personal emails). The agent's decisions, answers, booking, HubSpot, Slack and nudges
// are shared with Bison; this file only reads PlusVibe and turns its messages into the same shape the agent reads from Bison.
// PlusVibe has no reply-by-id lookup, so a PlusVibe reply id is "<thread_id>:<email_id>".
const API = "https://api.plusvibe.ai/api/v1";
const WORKSPACE = () => { const w = process.env.PLUSVIBE_WORKSPACE_ID; if (!w) throw new Error("PLUSVIBE_WORKSPACE_ID is not set"); return w; };

export async function pv(path: string, init: { method?: string; query?: Record<string, string>; body?: unknown } = {}) {
  const key = process.env.PLUSVIBE_API_KEY;
  if (!key) throw new Error("PLUSVIBE_API_KEY is not set");
  const qs = new URLSearchParams({ workspace_id: WORKSPACE(), ...(init.query ?? {}) });
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}?${qs}`, {
      method: init.method ?? "GET",
      headers: { "x-api-key": key, Accept: "application/json", "Content-Type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    // 10 requests a second per key; on 429 wait what PlusVibe asks
    if (res.status === 429 && attempt < 4) {
      await new Promise((s) => setTimeout(s, 1000 * Number(res.headers.get("retry-after") || 2)));
      continue;
    }
    if (!res.ok) throw new Error(`PlusVibe ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

export interface PvLead { id?: string; first_name?: string | null; last_name?: string | null; email?: string | null; company?: string | null; title?: string | null; subject1?: string; email1?: string }

const LEADS = new Map<string, PvLead>();
export async function pvLead(email: string): Promise<PvLead> {
  const k = email.toLowerCase();
  if (LEADS.has(k)) return LEADS.get(k)!;
  const rows: any[] = await pv("/lead/get", { query: { email: k } }).catch(() => []);
  const d = rows?.[0]?.lead_data ?? {};
  const lead: PvLead = {
    id: rows?.[0]?.id, first_name: d.first_name ?? null, last_name: d.last_name ?? null, email: d.email ?? k,
    company: d.company_name ?? null, title: d.job_title ?? null, subject1: d.custom_subject_1, email1: d.custom_email_1,
  };
  LEADS.set(k, lead);
  return lead;
}

const CAMPAIGNS = new Map<string, string>();
export async function pvCampaignName(id: string): Promise<string> {
  if (!CAMPAIGNS.has(id)) {
    const d = await pv("/campaign/get/name", { query: { campaign_id: id } }).catch(() => null);
    CAMPAIGNS.set(id, d?.campaign_name ?? `Campaign ${id}`);
  }
  return CAMPAIGNS.get(id)!;
}

/** One PlusVibe unibox message in the agent's (Bison) message shape. Sent = written from our inbox. */
export function pvMessage(e: any, lead: PvLead) {
  const from = String(e.from_address_email ?? "").toLowerCase();
  const ours = String(e.eaccount ?? "").toLowerCase();
  return {
    src: "plusvibe" as const,
    id: `${e.thread_id}:${e.id}`,
    folder: from && from === ours ? "Sent" : "Inbox",
    subject: e.subject ?? null,
    text_body: e.body?.text ?? e.content_preview ?? "",
    html_body: e.body?.html ?? null,
    date_received: e.timestamp_created ?? e.source_modified_at,
    campaign_id: e.campaign_id || null,
    lead: { ...lead, id: lead.id ?? e.lead_id },
    from_name: e.from_address_json?.[0]?.name ?? null,
    from_email_address: e.from_address_email ?? null,
    eaccount: e.eaccount ?? null,
    eaccount_first: e.eaccount_first_name ?? null,
    interested: false,
    automated_reply: false,
  };
}
export type PvMessage = ReturnType<typeof pvMessage>;

/** Every message in a conversation, oldest first. Campaign emails aren't in the unibox, same as Bison threads. */
async function pvThreadMessages(threadId: string): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await pv("/unibox/emails", { query: { thread_id: threadId, ...(after ? { starting_after: after } : {}) } });
    out.push(...(r?.data ?? []));
    if (!r?.has_more || !r?.next_starting_after) break;
    after = r.next_starting_after;
  }
  return out.sort((a, b) => Date.parse(a.timestamp_created) - Date.parse(b.timestamp_created));
}

/** The reply plus what came before and after it, like Bison's conversation-thread. */
export async function pvThread(id: string) {
  const [threadId, emailId] = id.split(":");
  const raw = await pvThreadMessages(threadId);
  const cur = raw.find((e) => e.id === emailId);
  if (!cur) return {};
  const lead = await pvLead(String(cur.lead ?? ""));
  const msgs = raw.map((e) => pvMessage(e, lead));
  const i = raw.indexOf(cur);
  return { current_reply: msgs[i], older_messages: msgs.slice(0, i), newer_messages: msgs.slice(i + 1) };
}

/** Lead replies received in the last `sinceMs`, newest first. Only campaign replies (not warmup or other mail). */
export async function pvRecentReplies(sinceMs: number, maxPages = 12) {
  const found: { id: string; date: string }[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await pv("/unibox/emails", { query: { email_type: "received", preview_only: "true", ...(after ? { starting_after: after } : {}) } });
    const rows: any[] = r?.data ?? [];
    let old = false;
    for (const e of rows) {
      if (Date.parse(e.timestamp_created) < sinceMs) { old = true; continue; }
      if (e.campaign_id && e.thread_id) found.push({ id: `${e.thread_id}:${e.id}`, date: e.timestamp_created });
    }
    if (old || !r?.has_more || !r?.next_starting_after) break;
    after = r.next_starting_after;
  }
  return found;
}

/** Step 1 email this lead got: the sent copy if PlusVibe has it, else the pre-filled copy on the lead. */
export async function pvFirstEmail(leadEmail: string): Promise<{ campaignId: string | null; subject: string; html: string } | null> {
  const r = await pv("/unibox/campaign-emails", { query: { lead: leadEmail } }).catch(() => null);
  const step1 = (r?.data ?? []).filter((m: any) => m.sent_on).sort((a: any, b: any) => Date.parse(a.sent_on) - Date.parse(b.sent_on))[0];
  if (step1) return { campaignId: step1.campaign_id ?? null, subject: step1.subject ?? "", html: step1.body ?? "" };
  const lead = await pvLead(leadEmail);
  return lead.email1 ? { campaignId: null, subject: lead.subject1 ?? "", html: lead.email1.replace(/\n/g, "<br>") } : null;
}

/** Reply in the same thread from the inbox that got the reply. */
export async function pvSendReply(p: { replyId: string; from: string; to: string; subject: string; html: string }) {
  const emailId = p.replyId.split(":")[1];
  const subject = /^re:/i.test(p.subject) ? p.subject : `Re: ${p.subject}`;
  return pv("/unibox/emails/reply", { method: "POST", body: { reply_to_id: emailId, from: p.from, to: p.to, subject, body: p.html } });
}
