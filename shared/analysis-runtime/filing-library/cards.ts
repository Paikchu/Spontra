import { LIBRARY_TOPICS, type LibraryCanonical, type LibraryFactRef, type LibraryTopicFamily } from "../../analysis-contract/filing-library.ts";

/** Changing the prompt or the checks rewrites every card once. */
export const LIBRARY_CARD_VERSION = "library-cards.v1";
export const CARD_LIMITS = { gist: 80, entities: 20, entity: 80, answers: 5, answer: 60, metrics: 12 } as const;

/** The taxonomy branch a section's topic comes from; null where the topic is the section's own kind and no model picks it. */
export function topicFamily(canonical: LibraryCanonical): LibraryTopicFamily | null {
  if (canonical === "business") return "business";
  if (canonical === "risk_factors") return "risk";
  if (canonical === "mdna" || canonical === "market_risk") return "mdna";
  if (canonical === "note" || canonical === "financial_statements") return "note";
  if (canonical === "press_release" || canonical === "event") return "release";
  return null;
}

/** A note's topic from its XBRL text block concept: standard names mean the same thing at every company. */
export function noteTopic(concept: string | null): (typeof LIBRARY_TOPICS)["note"][number] {
  const name = concept?.slice(concept.indexOf(":") + 1) ?? "";
  if (!name) return "statements";
  const rules: Array<[RegExp, (typeof LIBRARY_TOPICS)["note"][number]]> = [
    [/Segment/, "segment"], [/Concentration/, "concentration"], [/Revenue|Deferred(?:Revenue|Income)/, "revenue"], [/Lease/, "leases"],
    [/Debt|Borrowing|NotesPayable|CreditFacilit/, "debt"], [/Goodwill|Intangible/, "goodwill"], [/IncomeTax/, "tax"],
    [/Equity|Stock|ShareBased|EarningsPerShare|Compensation/, "equity"], [/Commitment|Contingenc|Litigation|Guarantee/, "commitments"],
    [/FairValue|Investment|Securities|Derivative|Financial(?:Instruments|Assets)/, "investments"], [/PropertyPlant|Equipment/, "property"],
    [/BusinessCombination|Acquisition/, "acquisitions"], [/Organization|Accounting(?:Policies|Standards)|SignificantAccounting|BasisOfPresentation/, "policies"],
  ];
  return rules.find(([pattern]) => pattern.test(name))?.[1] ?? "other";
}

const compact = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

export type CardDraft = { gist: string | null; entities: string[]; topic: string | null; answers: string[]; notes: string[] };

/**
 * What survives the checks from one model card: a gist without figures, entities that appear verbatim in the section,
 * a topic from the section's taxonomy branch. A field that fails is dropped with a note, never repaired by guessing.
 */
export function checkCard(raw: unknown, sectionText: string, family: LibraryTopicFamily | null): CardDraft {
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const notes: string[] = [];
  const text = compact(sectionText);
  const entities = [...new Set((Array.isArray(value.entities) ? value.entities : []).filter((e): e is string => typeof e === "string")
    .map(e => e.replace(/\s+/g, " ").trim()).filter(e => e.length >= 2 && e.length <= CARD_LIMITS.entity))];
  const kept = entities.filter(e => text.includes(compact(e)));
  if (kept.length < entities.length) notes.push(`entities not in the text: ${entities.filter(e => !kept.includes(e)).slice(0, 5).join(", ")}`);
  let gist = typeof value.gist === "string" ? value.gist.replace(/\s+/g, " ").trim() : "";
  // Figures belong to the filing's numbers, not to a gist; digits inside a product name the section names are fine.
  const withoutNames = kept.reduce((g, e) => g.split(e).join(""), gist);
  if (gist && ([...gist].length > CARD_LIMITS.gist || /\d/.test(withoutNames))) { notes.push("gist too long or contains figures"); gist = ""; }
  const allowed: readonly string[] = family ? LIBRARY_TOPICS[family] : [];
  let topic = typeof value.topic === "string" ? value.topic.trim().replace(/^[a-z]+\./, "") : "";
  if (topic && !allowed.includes(topic)) { notes.push(`topic ${topic} not in ${family ?? "taxonomy"}`); topic = ""; }
  const answers = (Array.isArray(value.answers) ? value.answers : []).filter((a): a is string => typeof a === "string")
    .map(a => a.replace(/\s+/g, " ").trim()).filter(a => a && [...a].length <= CARD_LIMITS.answer).slice(0, CARD_LIMITS.answers);
  return { gist: gist || null, entities: kept.slice(0, CARD_LIMITS.entities), topic: topic || null, answers, notes };
}

/** The XBRL concepts a section's passages show, most frequent first: its metrics, without the model. */
export function metricsFor(factRefs: LibraryFactRef[][]): string[] {
  const counts = new Map<string, number>();
  for (const refs of factRefs) for (const ref of refs) counts.set(ref.concept, (counts.get(ref.concept) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([concept]) => concept).slice(0, CARD_LIMITS.metrics);
}
