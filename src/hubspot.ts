import { C } from "./client.js";
// The owner's HubSpot CRM: every positive reply becomes a contact (lifecycle "Lead") with a deal
// "<Brand> - <dealSuffix>" in their deals pipeline. New positive reply -> HUBSPOT_STAGE_NEW. Call booked -> HUBSPOT_STAGE_BOOKED.
// The owner moves it on from there
// (no-shows, R2, proposal). Best effort: a HubSpot failure never blocks a reply to a lead.
const API = "https://api.hubapi.com";
const PIPELINE = () => process.env.HUBSPOT_PIPELINE_ID || "default";
const need = (n: string) => { const v = process.env[n]; if (!v) throw new Error(`${n} is not set`); return v; };
export const STAGE_NEW = () => need("HUBSPOT_STAGE_NEW"); // e.g. "Networking"
export const STAGE_BOOKED = () => need("HUBSPOT_STAGE_BOOKED"); // e.g. "R1 call"
const CLOSED = new Set(["closedwon", "closedlost"]);
const DEAL_TO_CONTACT = 3; // HUBSPOT_DEFINED association type id

async function hs(path: string, init: { method?: string; body?: unknown } = {}) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN is not set");
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`HubSpot ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? {} : res.json();
}

export const dealName = (company: string, email: string) =>
  `${(company || email.split("@")[1] || email).trim()} - ${C.hubspot.dealSuffix}`;

/** Find the contact by email, or create it as a Lead. Returns its id. */
export async function upsertContact(p: { email: string; firstName: string; lastName: string; company: string; title: string }): Promise<string> {
  const email = p.email.toLowerCase();
  const found = await hs("/crm/v3/objects/contacts/search", {
    method: "POST",
    body: { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }], properties: ["email"], limit: 1 },
  });
  if (found?.results?.[0]?.id) return found.results[0].id;
  const props: Record<string, string> = { email, lifecyclestage: "lead" };
  if (p.firstName) props.firstname = p.firstName;
  if (p.lastName) props.lastname = p.lastName;
  if (p.company) props.company = p.company;
  if (p.title) props.jobtitle = p.title;
  const made = await hs("/crm/v3/objects/contacts", { method: "POST", body: { properties: props } });
  return made.id;
}

/** The open deal with this name in the pipeline, if any. */
async function openDeal(name: string): Promise<{ id: string; stage: string } | null> {
  const r = await hs("/crm/v3/objects/deals/search", {
    method: "POST",
    body: {
      filterGroups: [{ filters: [
        { propertyName: "dealname", operator: "EQ", value: name },
        { propertyName: "pipeline", operator: "EQ", value: PIPELINE() },
      ] }],
      properties: ["dealname", "dealstage"], limit: 10,
    },
  });
  const open = (r?.results ?? []).find((d: any) => !CLOSED.has(d.properties?.dealstage));
  return open ? { id: open.id, stage: open.properties.dealstage } : null;
}

/** Positive reply: contact + open deal at `stage` (reuses an open deal with the same name; closed ones are left alone). */
export async function addLead(p: { email: string; firstName: string; lastName: string; company: string; title: string }, stage = STAGE_NEW()) {
  const contactId = await upsertContact(p);
  const name = dealName(p.company, p.email);
  const existing = await openDeal(name);
  if (existing) return { contactId, dealId: existing.id, created: false };
  const deal = await hs("/crm/v3/objects/deals", {
    method: "POST",
    body: {
      properties: { dealname: name, pipeline: PIPELINE(), dealstage: stage },
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: DEAL_TO_CONTACT }] }],
    },
  });
  return { contactId, dealId: deal.id as string, created: true };
}

/** Call booked: make sure the contact + deal exist, and move the deal to the booked stage if it's still at "new". */
export async function markBooked(p: { email: string; firstName: string; lastName: string; company: string; title: string }) {
  const r = await addLead(p, STAGE_BOOKED());
  if (!r.created) {
    const d = await openDeal(dealName(p.company, p.email));
    if (d && d.stage === STAGE_NEW()) {
      await hs(`/crm/v3/objects/deals/${d.id}`, { method: "PATCH", body: { properties: { dealstage: STAGE_BOOKED() } } });
    }
  }
  return r;
}

const NOTE_TO_CONTACT = 202; // HUBSPOT_DEFINED note -> contact
const NOTE_TO_DEAL = 214; // HUBSPOT_DEFINED note -> deal

/** A note on the contact (and deal) so the owner sees what the lead was sent when they open the booking. Body is HTML. */
export async function addNote(contactId: string, dealId: string | null, bodyHtml: string) {
  const associations: any[] = [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT }] }];
  if (dealId) associations.push({ to: { id: dealId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_DEAL }] });
  const made = await hs("/crm/v3/objects/notes", {
    method: "POST",
    body: { properties: { hs_timestamp: new Date().toISOString(), hs_note_body: bodyHtml }, associations },
  });
  return made.id as string;
}
