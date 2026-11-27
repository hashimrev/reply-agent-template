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
  configured: false,

  /** Brand name as it appears in Slack cards, HubSpot deals and prompts. */
  name: "Acme",
  /** The client's own sending/website domains. A referral can never point at these. */
  ownDomains: ["acme.com"],

  /** The person who takes the calls. title: "founder", "CEO", "head of sales"... */
  owner: { full: "Jane Doe", first: "Jane", title: "founder" },
  /** true = lead-facing copy says "we", never names the owner. */
  teamVoice: true,

  /** Short noun phrase, used in the follow-up prompt. */
  descriptor: "<what Acme sells, as a noun phrase>",
  /** One line for the classifier prompt: what the client does. */
  whatTheyDo: "<verb phrase: what Acme does for its customers>",
  /** Who the emails are signed by, for the classifier prompt. */
  signedBy: "a member of the Acme team; Jane takes the calls",

  /** What each campaign's last line offered. Delete unused ones by keeping one real offer under "primary" and leaving the
   *  others as copies of it. offerFor() picks by campaign name (campaignHint). */
  offers: {
    tertiary: { angle: "Offer C", noun: "the <offer C>", doVerb: "send over the <offer C>", campaignHint: "<word in the campaign name>", sent: `Offer C: "<the campaign's last line, verbatim>"` },
    secondary: { angle: "Offer B", noun: "the <offer B>", doVerb: "send over the <offer B>", campaignHint: "<word in the campaign name>", sent: `Offer B: "<the campaign's last line, verbatim>"` },
    primary: { angle: "Offer A", noun: "the <offer A>", doVerb: "send over the <offer A>", campaignHint: "<word in the campaign name>", sent: `Offer A: "<the campaign's last line, verbatim>"` },
  } as Record<Offer, { angle: string; noun: string; doVerb: string; campaignHint: string; sent: string }>,
  /** Campaign-name check order. First match wins, otherwise "primary". */
  offerOrder: ["tertiary", "secondary"] as Offer[],

  /** Approved copy blocks. */
  copy: {
    about: "<Who we are, one or two sentences, in the team voice.>",
    how: "<How the offer works. A short numbered list in the client's own wording.>",
    firstStep: "<The call, framed as step one of the offer.>",
    tertiaryLead: "<One sentence that links offer C to offer A, or repeat the first sentence of 'how'.>",
    cost: "<Approved answer to 'what does it cost'.>",
    legit: "<Approved answer to 'is this legit'. Only proof points from the client's own approved list.>",
    data: "<Approved answer to 'where did you get my info / the data'.>",
    needs: "<Approved answer to 'what do you need from me / how long is the call'. Do not promise screen sharing unless confirmed.>",
    handoffOwner: "I'll get back to you shortly.",
    handoffTeam: "I'm passing this to <Owner>, our <title>. They'll reply shortly.",
    /** Email to the person a lead pointed us to. One per offer. b = the brand name ("your" when unknown). */
    referralOffer: {
      primary: (b: string) => `<One or two sentences offering offer A to ${b === "your" ? "your" : `${b}'s`} team.>`,
      secondary: (b: string) => `<Offer B line for ${b}.>`,
      tertiary: (b: string) => `<Offer C line for ${b}.>`,
    } as Record<Offer, (brand: string) => string>,
    nudge2: (doVerb: string) => `still happy to ${doVerb} whenever suits. A short call is all we need to get started.`,
  },

  /** Phrases from the agent's own fixed wording. Lets it tell its replies from a person's when no tag exists. Use 5-8
   *  distinctive phrases that appear in your templates above. */
  agentPhrases: [
    "You're booked in for", "How about one of these instead?", "calendar, grab whichever time suits you", "just bumping this.",
  ],

  /** Free-text writer: things that must never appear in a lead-facing reply. */
  banned: {
    founderNames: /\bjane\b|\bdoe\b/i,
    techStack: /\b(MCP|Claude|Gemini|OpenAI|ChatGPT)\b/i,
  },

  /** Free-text writer: client-specific rules appended to its prompt. */
  writerExtras: [] as string[],

  slack: { channelHint: "#<client>-positive-responses" },

  hubspot: { dealSuffix: "Acme", stageNewLabel: "New", stageBookedLabel: "Booked" },
};

/** Which offer the campaign's last line made, from the campaign name. */
export function offerFor(campaignName: string): Offer {
  const n = campaignName.toLowerCase();
  for (const o of C.offerOrder) if (n.includes(C.offers[o].campaignHint)) return o;
  return "primary";
}
