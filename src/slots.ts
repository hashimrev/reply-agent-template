// Live open slots on the owner's HubSpot meetings link.
// Official Meetings API: GET /scheduler/v3/meetings/meeting-links/book/availability-page/{slug}
//   -> linkAvailability.linkAvailabilityByDuration[ms].availabilities[].startMillisUtc
// The unauthenticated booking-page feed rate-limits non-browser callers, so we use the authenticated API only.
const LABEL_TZ = "America/New_York"; // prospects are US brands; label times in ET
const MIN_LEAD_HOURS = 20; // never offer a slot sooner than this
const MAX_SLOTS = 3; // like the internal agent: up to 3 options, one per day
// US holidays we never offer (edit this list for your own calendar and country), even when the calendar shows them open. ET dates.
const HOLIDAYS = new Set(["2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2026-12-31", "2027-01-01", "2027-01-18", "2027-02-15"]);

export interface Slot { start: Date; label: string }

const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: LABEL_TZ });
const labelFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: LABEL_TZ, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

/** "Tuesday Nov 10 at 11:00 AM ET" */
export function label(d: Date): string {
  const p = Object.fromEntries(labelFmt.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.weekday} ${p.month} ${p.day} at ${p.hour}:${p.minute} ${p.dayPeriod} ET`;
}

function slug(bookingLink: string): string | null {
  return bookingLink.match(/hubspot\.com\/(?:meetings\/)?([^?#]+)/)?.[1]?.replace(/\/$/, "") ?? null;
}

/** Up to 3 slots on different days, at least MIN_LEAD_HOURS out, preferring on-the-hour or half-hour starts.
 *  `skipDays` are days already offered and turned down, as label day parts ("Tuesday Nov 17"). */
export function pick(starts: number[], now = Date.now(), skipDays: Set<string> = new Set()): Slot[] {
  const byDay = new Map<string, Date[]>();
  for (const ms of [...starts].sort((a, b) => a - b)) {
    if (ms < now + MIN_LEAD_HOURS * 3600 * 1000) continue;
    const d = new Date(ms);
    const k = dayKey.format(d);
    if (skipDays.has(label(d).split(" at ")[0])) continue;
    if (HOLIDAYS.has(k)) continue;
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(d);
  }
  const out: Slot[] = [];
  for (const [, ds] of byDay) {
    // mid-morning-ish ET first: first on-the-hour/half-hour slot at or after 11am ET, else the first clean one
    const hourET = (d: Date) => Number(new Intl.DateTimeFormat("en-US", { timeZone: LABEL_TZ, hour: "numeric", hour12: false }).format(d)) % 24;
    const clean = ds.filter((d) => d.getUTCMinutes() % 30 === 0);
    const best = clean.find((d) => hourET(d) >= 11) ?? clean[0] ?? ds[0];
    out.push({ start: best, label: label(best) });
    if (out.length === MAX_SLOTS) break;
  }
  return out;
}

export interface Availability { slug: string; durationMs: number; starts: number[] }

/** Open start times on the booking link via HubSpot's official Meetings API (private-app token from the owner's
 *  portal, env HUBSPOT_TOKEN). null if there's no token or the calendar can't be read. */
export async function availability(bookingLink: string, token = process.env.HUBSPOT_TOKEN): Promise<Availability | null> {
  const s = slug(bookingLink);
  if (!s || !token) return null;
  const url = `https://api.hubapi.com/scheduler/v3/meetings/meeting-links/book/availability-page/${encodeURIComponent(s)}` +
    `?timezone=${encodeURIComponent(LABEL_TZ)}`;
  for (const wait of [0, 2000, 5000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(url, { headers: { Accept: "application/json", Authorization: `Bearer ${token}` } });
      if (res.status === 429) continue;
      if (!res.ok) return null;
      const j = await res.json();
      const byDur = j?.linkAvailability?.linkAvailabilityByDuration ?? {};
      const [dur, first] = (Object.entries(byDur)[0] ?? []) as [string, { availabilities?: { startMillisUtc: number }[] }] | [];
      if (!dur) return null;
      return { slug: s, durationMs: Number(dur), starts: (first?.availabilities ?? []).map((a) => a.startMillisUtc) };
    } catch { /* retry */ }
  }
  return null;
}

/** Up to 3 open slots, skipping the days in `skipDays`. [] if the calendar can't be read. */
export async function suggestSlots(bookingLink: string, skipDays: Set<string> = new Set()): Promise<Slot[]> {
  const a = await availability(bookingLink);
  return a ? pick(a.starts, Date.now(), skipDays) : [];
}

/** The open start time matching a label we offered, or a time the lead proposed (ISO), if it's still free. */
export function matchSlot(a: Availability, want: { slot?: string; time?: string }): number | null {
  if (want.slot) {
    const hit = a.starts.find((ms) => label(new Date(ms)) === want.slot!.trim());
    if (hit) return hit;
  }
  if (want.time) {
    const t = Date.parse(want.time);
    if (!Number.isNaN(t) && a.starts.includes(t) && t >= Date.now() + 2 * 3600 * 1000) return t;
  }
  return null;
}

/** Book the call on the owner's HubSpot meetings link. HubSpot sends the calendar invite to the lead. */
export async function bookSlot(p: {
  a: Availability; startMs: number; email: string; firstName: string; lastName: string; guestEmails?: string[];
}, token = process.env.HUBSPOT_TOKEN): Promise<{ ok: true; start: string } | { ok: false; error: string }> {
  if (!token) return { ok: false, error: "no HubSpot token" };
  const res = await fetch(`https://api.hubapi.com/scheduler/v3/meetings/meeting-links/book?timezone=${encodeURIComponent(LABEL_TZ)}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      slug: p.a.slug, startTime: p.startMs, duration: p.a.durationMs, email: p.email,
      firstName: p.firstName || p.email.split("@")[0], lastName: p.lastName || "-", guestEmails: p.guestEmails ?? [],
      timezone: LABEL_TZ, locale: "en-us", likelyAvailableUserIds: [],
    }),
  });
  if (!res.ok) return { ok: false, error: `HubSpot ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const j = await res.json();
  if (j?.isOffline) return { ok: false, error: "HubSpot booked offline (no calendar event)" };
  return { ok: true, start: j?.start ?? new Date(p.startMs).toISOString() };
}

/** True if the lead has booked a meeting on the owner's HubSpot since `sinceMs`, from the contact's
 *  "last meeting booked" date. null if we can't tell (no token, or the token lacks crm.objects.contacts.read). */
export async function bookedSince(email: string, sinceMs: number, token = process.env.HUBSPOT_TOKEN): Promise<boolean | null> {
  if (!token || !email) return null;
  try {
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email.toLowerCase() }] }],
        properties: ["engagements_last_meeting_booked"], limit: 1,
      }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    const c = j?.results?.[0];
    if (!c) return false; // not in HubSpot -> never booked through the link
    const v = c.properties?.engagements_last_meeting_booked;
    return v ? Date.parse(v) >= sinceMs - 3600_000 : false;
  } catch { return null; }
}

/** Start time (ms) of the next upcoming HubSpot meeting on this contact. Best effort: null when the token lacks meeting scopes or nothing is found. */
export async function nextMeetingStart(email: string, token = process.env.HUBSPOT_TOKEN): Promise<number | null> {
  if (!token || !email) return null;
  const h = { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` };
  try {
    const cs = await fetch("https://api.hubapi.com/crm/v3/objects/contacts/search", {
      method: "POST", headers: h,
      body: JSON.stringify({ filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email.toLowerCase() }] }], limit: 1 }),
    });
    const id = (await cs.json())?.results?.[0]?.id;
    if (!cs.ok || !id) return null;
    const as = await fetch(`https://api.hubapi.com/crm/v4/objects/contacts/${id}/associations/meetings`, { headers: h });
    const ids: string[] = ((await as.json())?.results ?? []).map((x: any) => String(x.toObjectId));
    if (!as.ok || !ids.length) return null;
    const ms = await fetch("https://api.hubapi.com/crm/v3/objects/meetings/batch/read", {
      method: "POST", headers: h,
      body: JSON.stringify({ properties: ["hs_meeting_start_time"], inputs: ids.map((i) => ({ id: i })) }),
    });
    if (!ms.ok) return null;
    const now = Date.now();
    const starts = ((await ms.json())?.results ?? []).map((m: any) => Date.parse(m.properties?.hs_meeting_start_time ?? "")).filter((t: number) => t > now - 3600_000);
    return starts.length ? Math.min(...starts) : null;
  } catch { return null; }
}

/** `days` after `fromMs`, any day of the week (weekends included). */
const weekdayET = new Intl.DateTimeFormat("en-US", { timeZone: LABEL_TZ, weekday: "short" });
const hourET = new Intl.DateTimeFormat("en-US", { timeZone: LABEL_TZ, hour: "numeric", hour12: false });
export const isWeekendET = (ms: number) => ["Sat", "Sun"].includes(weekdayET.format(new Date(ms)));

/** No follow-ups over the weekend (owner request). A time that lands on Saturday or Sunday ET moves to Monday 9:00 AM ET. */
export function rollOffWeekend(ms: number): number {
  if (!isWeekendET(ms)) return ms;
  let t = ms;
  while (isWeekendET(t)) t += 3600_000; // first moment of Monday ET
  while (Number(hourET.format(new Date(t))) % 24 !== 9) t += 3600_000;
  return t - (t % 3600_000); // on the hour (ET is a whole-hour offset)
}

export function nudgeTime(fromMs: number, days: number): number {
  return rollOffWeekend(fromMs + days * 86400_000);
}
