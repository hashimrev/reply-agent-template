// Offline check of the Instantly adapter against fixtures shaped like the API v2 docs. No network.
process.env.INSTANTLY_API_KEY = "test";
const calls: { url: string; init: any }[] = [];
const T = "2026-11-24T10:00:00.000Z";
const mk = (id: string, ue: number, from: string, to: string, body: string, ts: string) => ({
  id, thread_id: "T1", ue_type: ue, subject: "Quick question", campaign_id: "c1", lead: "cand@acme.com", lead_id: "L1", eaccount: "jo@sender.com",
  from_address_email: from, from_address_json: [{ name: "Cand", address: from }], body: { text: body, html: `<p>${body}</p>` },
  timestamp_created: ts, is_auto_reply: false,
});
const sent = mk("e1", 1, "jo@sender.com", "cand@acme.com", "Hi, open to a role?", "2026-11-24T09:00:00.000Z");
const got = mk("e2", 2, "cand@acme.com", "jo@sender.com", "Yes, send details", T);
(globalThis as any).fetch = async (url: string, init: any = {}) => {
  calls.push({ url: String(url), init });
  const u = String(url);
  const ok = (j: unknown) => ({ ok: true, status: 200, json: async () => j, text: async () => "" });
  if (u.includes("/emails/reply")) return ok({ id: "e3" });
  if (u.includes("/emails?") && u.includes("search=thread")) return ok({ items: [sent, got] });
  if (u.includes("/emails?") && u.includes("email_type=received")) return ok({ items: [got, { ...got, id: "w1", campaign_id: null }] });
  if (u.includes("/emails?") && u.includes("email_type=sent")) return ok({ items: [sent] });
  if (u.includes("/leads/list")) return ok({ items: [{ id: "L1", email: "cand@acme.com", first_name: "Sam", last_name: "Lee", company_name: "Acme", job_title: "Engineer" }] });
  if (u.includes("/campaigns/")) return ok({ id: "c1", name: "Recruiter | Candidates" });
  if (u.includes("/accounts/")) return ok({ email: "jo@sender.com", first_name: "Jo" });
  return { ok: false, status: 404, json: async () => ({}), text: async () => "no fixture" };
};
const I = await import("../src/instantly.js");
const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const th: any = await I.instThread("T1:e2");
assert(th.current_reply?.id === "T1:e2" && th.current_reply.folder === "Inbox", "thread: current reply found, folder Inbox");
assert(th.older_messages.length === 1 && th.older_messages[0].folder === "Sent", "thread: our step 1 is an older Sent message");
assert(th.current_reply.lead.first_name === "Sam" && th.current_reply.eaccount_first === "Jo", "thread: lead and sender first name filled");
const rec = await I.instRecentReplies(Date.parse("2026-11-23T00:00:00Z"));
assert(rec.length === 1 && rec[0].id === "T1:e2", "recent: campaign replies only (non-campaign mail dropped)");
const fe = await I.instFirstEmail("cand@acme.com");
assert(fe?.campaignId === "c1" && /open to a role/.test(fe.html), "first email: step 1 we sent");
assert((await I.instCampaignName("c1")) === "Recruiter | Candidates", "campaign name");
await I.instSendReply({ replyId: "T1:e2", from: "jo@sender.com", subject: "Quick question", html: "<div>hi</div>" });
const post = calls.find((c) => c.url.includes("/emails/reply"))!;
const body = JSON.parse(post.init.body);
assert(body.reply_to_uuid === "e2" && body.eaccount === "jo@sender.com" && body.subject === "Re: Quick question" && body.body.html === "<div>hi</div>", "send: reply_to_uuid, eaccount, Re: subject, html body");
assert(post.init.headers.Authorization === "Bearer test", "auth is a bearer token");
