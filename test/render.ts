// Print the exact agent copy for every turn, from a teammate inbox and from the owner's, plus a few checks. Sends nothing.
import { templateMessage, handoffMessage, confirmMessage, newTimesMessage, offeredSlots, isAgentMessage, toHtml, parseFollowUp } from "../src/prompt.js";
import { pick, label } from "../src/slots.js";
import { C } from "../src/client.js";
const link = "https://meetings.hubspot.com/owner";
const slots = ["Tuesday Nov 17 at 12:00 PM ET", "Wednesday Nov 18 at 11:00 AM ET", "Thursday Nov 19 at 11:00 AM ET"];
for (const sender of ["Becky", C.owner.first]) {
  console.log(`===== sent from ${sender}'s inbox\n--- plain yes, with calendar slots\n${templateMessage("Gail", "secondary", slots, sender, link)}`);
  console.log(`\n--- plain yes, no slots (no HubSpot token yet)\n${templateMessage("Gail", "secondary", [], sender, link)}`);
  console.log(`\n--- question / referral\n${handoffMessage("Mark", sender)}`);
  console.log(`\n--- follow-up: picked a time, booked\n${confirmMessage("Gail", slots[0], sender)}`);
  console.log(`\n--- follow-up: none work\n${newTimesMessage("Gail", ["Monday Nov 23 at 11:00 AM ET", "Tuesday Nov 24 at 12:00 PM ET"], sender, link)}`);
  console.log(`\n--- follow-up: their time is taken\n${newTimesMessage("Gail", ["Monday Nov 23 at 11:00 AM ET"], sender, link, true)}\n`);
}
const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL", m); process.exitCode = 1; } else console.log("ok  ", m); };
const msg = templateMessage("Gail", "secondary", slots, "Becky", link);
assert(offeredSlots(msg).length === 3, "offeredSlots finds the 3 listed times");
assert(isAgentMessage({ html_body: toHtml(msg) }), "agent tag detected in html");
assert(isAgentMessage({ text_body: `Great. ${C.agentPhrases[0]}` }), "agent reply detected by its fixed wording");
assert(!isAgentMessage({ text_body: "Hey Jeson, it's the owner here - does Tuesday work?" }), "hand-written reply not mistaken for agent");
assert(!templateMessage("G", "primary", [], "Becky", link).includes("What time works"), "never asks an open 'what time works'");
assert(parseFollowUp('{"action":"book"}').action === "human", "book without a slot/time falls back to human");
const now = Date.parse("2026-11-12T15:00:00Z");
const starts = [Date.parse("2026-11-17T17:00:00Z"), Date.parse("2026-11-18T16:00:00Z"), Date.parse("2026-11-24T17:00:00Z")];
const p = pick(starts, now, new Set([label(new Date(starts[0])).split(" at ")[0]]));
assert(p.length === 2 && !p.some((s) => s.label.startsWith("Tuesday Nov 17")), "turned-down day is skipped");

// Nudges
import { nudgeMessage } from "../src/prompt.js";
import { nudgeTime } from "../src/slots.js";
console.log(`\n===== nudges (Lisa's inbox)\n--- nudge 1, with slots\n${nudgeMessage(1, "Jeson", "secondary", slots.slice(0, 2), "Lisa", link)}`);
console.log(`\n--- nudge 1, no token yet\n${nudgeMessage(1, "Jeson", "secondary", [], "Lisa", link)}`);
console.log(`\n--- nudge 2\n${nudgeMessage(2, "Jeson", "secondary", [], "Lisa", link)}\n`);
const et = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
const sent = Date.parse("2026-11-11T06:49:00Z"); // Wed
assert(nudgeTime(sent, 1) - sent === 86400_000, `nudge 1 exactly 24h later -> ${et(nudgeTime(sent, 1))}`);
assert(et(nudgeTime(nudgeTime(sent, 1), 2)) === "Mon, Nov 16, 9:00 AM", `nudge 2 would land Saturday, so it moves to Monday 9 AM ET -> ${et(nudgeTime(nudgeTime(sent, 1), 2))}`);
assert(isAgentMessage({ text_body: nudgeMessage(1, "J", "primary", [], "Lisa", link) }), "nudge recognised as agent message");

import { rollOffWeekend } from "../src/slots.js";
assert(rollOffWeekend(Date.parse("2026-11-29T23:59:00Z")) === Date.parse("2026-11-30T14:00:00Z"), "Sunday evening nudge moves to Monday 9:00 AM ET");
assert(rollOffWeekend(Date.parse("2026-11-27T21:00:00Z")) === Date.parse("2026-11-27T21:00:00Z"), "Friday afternoon nudge is untouched");
assert(rollOffWeekend(Date.parse("2026-11-30T05:00:00Z")) === Date.parse("2026-11-30T05:00:00Z"), "Monday after midnight is untouched");
