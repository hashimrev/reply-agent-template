// FICTIONAL EXAMPLE: "Northbridge Recruiting" does not exist. Every name, number and claim below is made up to show the SHAPE
// of a filled-in file for an agency recruiter who sells to hiring managers. Do not reuse any of it. Copy src/client.ts and fill it from the real client.
// THE client file. Everything that makes this agent "Acme's reply agent" instead of someone else's lives here and in
// knowledge.md. The rest of src/ is client-neutral. See CLAUDE.md for the customisation steps and
// examples/northbridge-recruiting/ for a filled-in FICTIONAL example (client.ts + knowledge.md).
//
// Copy rule: the agent never lets the model write to a lead, except in free-text mode (compose.ts), which is fenced by
// knowledge.md plus a guard. Every string below is APPROVED COPY the client has signed off on. Do not invent any.
// Plain text, no em dashes. The agent refuses to run while `configured` is false.

export type Offer = "primary" | "secondary" | "tertiary";

export const C = {
  /** Flip to true only after every field below is filled from the client's onboarding material. */
  configured: true,

  /** Brand name as it appears in Slack cards, HubSpot deals and prompts. */
  name: "Northbridge Recruiting",
  /** The client's own sending/website domains. A referral can never point at these. */
  ownDomains: ["northbridge-recruiting.example"],

  /** The person who takes the calls. title: "founder", "CEO", "head of sales"... */
  owner: { full: "Jordan Reed", first: "Jordan", title: "founder" },
  /** true = lead-facing copy says "we", never names the owner. */
  teamVoice: false, // solo recruiter: replies are in first person ("I")

  /** Short noun phrase, used in the follow-up prompt. */
  descriptor: "a boutique recruiter placing backend and data engineers",
  /** One line for the classifier prompt: what the client does. */
  whatTheyDo: "places senior backend and data engineers with growth-stage software companies on contingency",
  /** Who the emails are signed by, for the classifier prompt. */
  signedBy: "Jordan Reed, the founder; Jordan takes the calls",

  /** What each campaign's last line offered. Delete unused ones by keeping one real offer under "primary" and leaving the
   *  others as copies of it. offerFor() picks by campaign name (campaignHint). */
  offers: {
    tertiary: { angle: "Salary benchmark", noun: "the salary benchmark", doVerb: "send over the salary benchmark", campaignHint: "benchmark", sent: `Benchmark: "Want the salary benchmark for senior backend roles in your city?"` },
    secondary: { angle: "Role spec", noun: "the role spec", doVerb: "send over the role spec", campaignHint: "spec", sent: `Role spec: "I have a backend engineer who fits what you're hiring. Want the profile?"` },
    primary: { angle: "Candidates", noun: "the shortlist", doVerb: "send over the shortlist", campaignHint: "candidates", sent: `Candidates: "I can send you 3 vetted backend engineers this week. Want the shortlist?"` },
  } as Record<Offer, { angle: string; noun: string; doVerb: string; campaignHint: string; sent: string }>,
  /** Campaign-name check order. First match wins, otherwise "primary". */
  offerOrder: ["tertiary", "secondary"] as Offer[],

  /** Approved copy blocks. */
  copy: {
    about: "Quick background: I run a small recruiting practice that places senior backend and data engineers with software companies.",
    how: "Here's how it works:\n\n1. You send me the role: stack, seniority, location, salary band.\n2. I send a shortlist of up to 3 vetted candidates within 5 working days, each with a one-page summary.\n3. You interview whoever you like. You only pay if you hire.",
    firstStep: "The first step is a 15-minute call so I can understand the role.",
    tertiaryLead: "I send the benchmark as part of a short role review.",
    cost: "Contingency only. You pay a fee if you hire someone I introduce, and nothing otherwise. I'll share the fee terms on the call.",
    legit: "Fair question. I'm Jordan Reed and I run Northbridge Recruiting. Happy to share a couple of past placements you can check.",
    data: "Fair question. I found your details on your company website and public professional profiles. If you'd rather I didn't contact you, say so and I'll remove you.",
    needs: "Very little. A short description of the role is enough to start.\n\nIt's a 15-minute call.",
    handoffOwner: "I'll get back to you shortly.",
    handoffTeam: "I'm passing this to Jordan. They'll reply shortly.",
    referralOffer: {
      primary: (b: string) => `I place senior backend and data engineers. Could I send ${b === "your" ? "your" : `${b}'s`} hiring lead a shortlist of 3 vetted candidates this week?`,
      secondary: (b: string) => `I have an engineer who may fit a role at ${b === "your" ? "your company" : b}. Could I send the profile?`,
      tertiary: (b: string) => `Could I send ${b === "your" ? "your" : `${b}'s`} hiring lead a salary benchmark for senior backend roles?`,
    } as Record<Offer, (brand: string) => string>,
    nudge2: (doVerb: string) => `still happy to ${doVerb} whenever suits. A 15-minute call is all I need to get started.`,
  },

  /** Phrases from the agent's own fixed wording. Lets it tell its replies from a person's when no tag exists. Use 5-8
   *  distinctive phrases that appear in your templates above. */
  agentPhrases: [
    "You're booked in for", "How about one of these instead?", "calendar, grab whichever time suits you", "just bumping this.", "I run a small recruiting practice",
  ],

  /** Free-text writer: things that must never appear in a lead-facing reply. */
  banned: {
    founderNames: /\bjane\b|\bdoe\b/i,
    techStack: /\b(MCP|Claude|Gemini|OpenAI|ChatGPT)\b/i,
  },

  /** Free-text writer: client-specific rules appended to its prompt. */
  writerExtras: [] as string[],

  slack: { channelHint: "#recruiting-replies" },

  hubspot: { dealSuffix: "Northbridge", stageNewLabel: "New", stageBookedLabel: "Intro call" },
};

/** Which offer the campaign's last line made, from the campaign name. */
export function offerFor(campaignName: string): Offer {
  const n = campaignName.toLowerCase();
  for (const o of C.offerOrder) if (n.includes(C.offers[o].campaignHint)) return o;
  return "primary";
}
