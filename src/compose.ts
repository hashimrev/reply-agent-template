// Free-text replies: for a reply the ready-made answers don't cover, the model WRITES the reply from
// knowledge.md instead of handing it to a person. Code wraps it (greeting, times block, sign-off), then a second model
// call and fixed rules check it. Anything that fails a check goes to a person exactly as before.
import { KNOWLEDGE } from "./knowledge.js";
import { C } from "./client.js";

const WHO = C.teamVoice ? `a member of the ${C.name} team` : `${C.owner.full} of ${C.name}`;
const VOICE = C.teamVoice
  ? `Write as the team: "we", "our team". Never "I", "my", never name ${C.owner.first} or any founder.`
  : `Write in the first person as ${C.owner.first}: "I", "my". Never say "we" as if there were a team unless the knowledge base says there is one.`;
const GUARD_VOICE = C.teamVoice
  ? `It names ${C.owner.first} or a founder, or uses "I" or "my" instead of the team voice.`
  : `It speaks as a team ("we", "our team") when the sender is one person, or names someone other than ${C.owner.first}.`;

export const WRITER_PROMPT = `You write replies to leads who answered a cold email from ${C.name}. You are ${WHO}. Use ONLY the knowledge base below for facts.

${KNOWLEDGE}

## How to write
- Answer what they actually asked, directly, in the first lines. Then, if it fits, the next step is a short call (the first step of the offer).
- ${VOICE}
- Plain words, short sentences, 40 to 120 words. No hype, no jargon, no em dashes, no bullet overload (a short numbered list is fine for the steps).
- Never invent facts, numbers, clients, results, timelines or features. If the knowledge base does not answer it, hand off.
- Never quote prices or ranges unless the knowledge base gives them.
${C.writerExtras.map((x) => `- ${x}`).join("\n")}
- Do not include a greeting, a sign-off, call times or a booking link. Code adds those.
- If they ask us to follow up or reach back out later, hand off. We cannot promise to contact them on a date.
- If their reply is only a thank-you, an out-of-office, hostile, a legal or spam complaint, an unsubscribe, a flat no, a price negotiation, or you are not certain, set handoff true.

## Output
Return exactly one JSON object and nothing else:
{"handoff":false,"include_times":true,"body":"..."}
{"handoff":true,"reason":"<one short line for the team>"}
Set include_times false only when offering call times would be rude or pointless (for example they asked us to wait until a later date).`;

export const GUARD_PROMPT = `You check a draft reply from the ${C.name} team before it is sent to a lead. You get the knowledge base, the lead's message and the draft.

Fail the draft if ANY of these is true:
- It states a fact, number, client, result, price, timeline or capability that is not in the knowledge base.
- It does not answer what the lead actually asked, or answers a different question.
- It promises something we have not confirmed (screen sharing, security terms, turnaround, custom work, discounts).
- ${GUARD_VOICE}
- It quotes a paid price or range.
- The tone is pushy, defensive, or ignores that the lead is upset or confused.
- The lead is hostile, asks to stop, threatens, or needs a person for a decision the knowledge base says is for a person.

Return exactly one JSON object and nothing else: {"ok":true} or {"ok":false,"problem":"<one short line>"}`;

export interface Written { handoff: boolean; reason?: string; include_times?: boolean; body?: string }

export function parseWritten(raw: string): Written {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { handoff: true, reason: "writer output unreadable" };
  try {
    const d = JSON.parse(m[0]) as Written;
    if (d.handoff) return { handoff: true, reason: d.reason ?? "" };
    if (typeof d.body === "string" && d.body.trim()) return { handoff: false, include_times: d.include_times !== false, body: d.body.trim() };
  } catch { /* fall through */ }
  return { handoff: true, reason: "writer output invalid" };
}

export function parseGuard(raw: string): { ok: boolean; problem?: string } {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, problem: "guard output unreadable" };
  try {
    const d = JSON.parse(m[0]);
    return d.ok === true ? { ok: true } : { ok: false, problem: String(d.problem ?? "guard said no") };
  } catch { return { ok: false, problem: "guard output invalid" }; }
}

/** Fixed rules, no model. Returns the problem, or null if the draft passes. */
export function hardRules(body: string): string | null {
  if (body.length > 1300) return "too long";
  if (/[—–]/.test(body)) return "dash";
  if (C.teamVoice && C.banned.founderNames.test(body)) return "names the founder";
  if (/\b(I|I'm|I'll|I've|I'd|my|me)\b/.test(body)) return "first person singular";
  if (/\$\s?(5|7\.5|10|15|20)\s?k\b|\$[\d.,]+k?\s*(a|per|\/)\s*month|retainer|\bsprint\b/i.test(body)) return "quotes a price";
  if (C.banned.techStack.test(body)) return "names the tech stack";
  if (/it'?s not [^.]{1,60}, it'?s /i.test(body)) return "banned reframe";
  const urls = body.match(/https?:\/\/\S+/g) ?? [];
  if (urls.some((u) => !KNOWLEDGE.includes(u.replace(/[).,]+$/, "")))) return "link not in knowledge base";
  return null;
}

/** Wrap the written body: greeting, optional times block, sign-off. */
export function assemble(p: { firstName: string; body: string; includeTimes: boolean; slotLabels: string[]; link: string; sender: string }): string {
  const hi = p.firstName ? `Hey ${p.firstName},` : "Hey there,";
  const times = !p.includeTimes ? "" : p.slotLabels.length
    ? `\n\nA few times that work:\n\n${p.slotLabels.join("\n")}\n\nOr grab any time here: ${p.link}`
    : `\n\nGrab any time that suits you here: ${p.link}`;
  return `${hi}\n\n${p.body}${times}\n\n${p.sender}`;
}
