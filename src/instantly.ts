// Instantly (API v2). The agent's decisions, answers, booking, CRM, Slack and nudges are shared with the other senders;
// this file only reads Instantly and turns its emails into the same shape the agent reads from Bison.
// Instantly has no reply-by-id lookup that returns the thread, so an Instantly reply id is "<thread_id>:<email_id>".
// Docs: https://developer.instantly.ai (list emails, reply to an email, list leads, get campaign).
// Rate limit: 20 requests a minute on the emails endpoints. inst() backs off on 429.
const API = process.env.INSTANTLY_BASE_URL || "https://api.instantly.ai/api/v2";

export async function inst(path: string, init: { method?: string; query?: Record<string, string>; body?: unknown } = {}) {
  const key = process.env.INSTANTLY_API_KEY;
  if (!key) throw new Error("INSTANTLY_API_KEY is not set");
  const qs = init.query && Object.keys(init.query).length ? `?${new URLSearchParams(init.query)}` : "";
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}${qs}`, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "Content-Type": "application/json" },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 429 && attempt < 5) {
      await new Promise((s) => setTimeout(s, 4000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`Instantly ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
}

export interface InstLead { id?: string; first_name?: string | null; last_name?: string | null; email?: string | null; company?: string | null; title?: string | null }

const LEADS = new Map<string, InstLead>();
export async function instLead(email: string): Promise<InstLead> {
  const k = email.toLowerCase();
  if (LEADS.has(k)) return LEADS.get(k)!;
  const r = await inst("/leads/list", { method: "POST", body: { contacts: [k], limit: 1 } }).catch(() => null);
  const d = r?.items?.[0] ?? {};
  const lead: InstLead = {
    id: d.id, first_name: d.first_name ?? null, last_name: d.last_name ?? null, email: d.email ?? k,
    company: d.company_name ?? null, title: d.job_title ?? null,
  };
  LEADS.set(k, lead);
  return lead;
}

const CAMPAIGNS = new Map<string, string>();
export async function instCampaignName(id: string): Promise<string> {
  if (!id) return "Campaign";
  if (!CAMPAIGNS.has(id)) {
    const d = await inst(`/campaigns/${id}`).catch(() => null);
    CAMPAIGNS.set(id, d?.name ?? `Campaign ${id}`);
  }
  return CAMPAIGNS.get(id)!;
}

/** The sending mailbox's first name, for the sign-off. Instantly emails don't carry it, the account record does. */
const ACCOUNTS = new Map<string, string>();
export async function instAccountFirst(eaccount: string): Promise<string> {
  if (!eaccount) return "";
  if (!ACCOUNTS.has(eaccount)) {
    const d = await inst(`/accounts/${encodeURIComponent(eaccount)}`).catch(() => null);
    ACCOUNTS.set(eaccount, String(d?.first_name ?? "").trim().split(/\s+/)[0] ?? "");
  }
  return ACCOUNTS.get(eaccount)!;
}

/** One Instantly email in the agent's (Bison) message shape. ue_type 2 = received, everything else was sent by us. */
export function instMessage(e: any, lead: InstLead, first: string) {
  return {
    src: "instantly" as const,
    id: `${e.thread_id}:${e.id}`,
    folder: e.ue_type === 2 ? "Inbox" : "Sent",
    subject: e.subject ?? null,
    text_body: e.body?.text ?? e.content_preview ?? "",
    html_body: e.body?.html ?? null,
    date_received: e.timestamp_created ?? e.timestamp_email,
    campaign_id: e.campaign_id || null,
    lead: { ...lead, id: lead.id ?? e.lead_id },
    from_name: e.from_address_json?.[0]?.name ?? null,
    from_email_address: e.from_address_email ?? null,
    eaccount: e.eaccount ?? null,
    eaccount_first: first,
    interested: false,
    automated_reply: !!e.is_auto_reply,
  };
}
export type InstMessage = ReturnType<typeof instMessage>;

/** Every message in a conversation, oldest first. */
async function instThreadMessages(threadId: string): Promise<any[]> {
  const out: any[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await inst("/emails", { query: { search: `thread:${threadId}`, sort_order: "asc", limit: "100", preview_only: "false", ...(after ? { starting_after: after } : {}) } });
    out.push(...(r?.items ?? []));
    if (!r?.next_starting_after || (r?.items ?? []).length < 100) break;
    after = r.next_starting_after;
  }
  return out.sort((a, b) => Date.parse(a.timestamp_created) - Date.parse(b.timestamp_created));
}

/** The reply plus what came before and after it, like Bison's conversation-thread. */
export async function instThread(id: string) {
  const [threadId, emailId] = id.split(":");
  const raw = await instThreadMessages(threadId);
  const cur = raw.find((e) => e.id === emailId);
  if (!cur) return {};
  const lead = await instLead(String(cur.lead ?? ""));
  const first = await instAccountFirst(String(cur.eaccount ?? ""));
  const msgs = raw.map((e) => instMessage(e, lead, first));
  const i = raw.indexOf(cur);
  return { current_reply: msgs[i], older_messages: msgs.slice(0, i), newer_messages: msgs.slice(i + 1) };
}

/** Lead replies received in the last `sinceMs`, newest first. Only campaign replies (not warmup or other mail). */
export async function instRecentReplies(sinceMs: number, maxPages = 5) {
  const found: { id: string; date: string }[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const r = await inst("/emails", { query: {
      email_type: "received", sort_order: "desc", limit: "100", preview_only: "true",
      min_timestamp_created: new Date(sinceMs).toISOString(), ...(after ? { starting_after: after } : {}),
    } });
    const rows: any[] = r?.items ?? [];
    for (const e of rows) if (e.campaign_id && e.thread_id && e.ue_type === 2) found.push({ id: `${e.thread_id}:${e.id}`, date: e.timestamp_created });
    if (!r?.next_starting_after || rows.length < 100) break;
    after = r.next_starting_after;
  }
  return found;
}

/** Step 1 email this lead got, from what we sent them. */
export async function instFirstEmail(leadEmail: string): Promise<{ campaignId: string | null; subject: string; html: string } | null> {
  const r = await inst("/emails", { query: { lead: leadEmail, email_type: "sent", sort_order: "asc", limit: "20", preview_only: "false" } }).catch(() => null);
  const step1 = (r?.items ?? []).find((m: any) => m.campaign_id);
  if (!step1) return null;
  return { campaignId: step1.campaign_id ?? null, subject: step1.subject ?? "", html: step1.body?.html ?? String(step1.body?.text ?? "").replace(/\n/g, "<br>") };
}

/** Reply in the same thread from the mailbox that got the reply. Instantly answers the original sender, so a different
 *  recipient (a referral) cannot be emailed through this call. */
export async function instSendReply(p: { replyId: string; from: string; subject: string; html: string }) {
  const emailId = p.replyId.split(":")[1];
  const subject = /^re:/i.test(p.subject) ? p.subject : `Re: ${p.subject}`;
  return inst("/emails/reply", { method: "POST", body: { reply_to_uuid: emailId, eaccount: p.from, subject, body: { html: p.html } } });
}
