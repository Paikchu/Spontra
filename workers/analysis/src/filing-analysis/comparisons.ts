import type { FilingFactRow } from "../../../../shared/analysis-contract/filing-content.ts";
import type { MaterialSnapshot } from "../../../../shared/analysis-contract/filing-material.ts";
import { sourceText } from "../filing-material/read.ts";
const statements = {
    balance: /balance sheets?|statements? of financial (?:position|condition)/i,
    income: /statements? of (?:consolidated )?(?:operations|income|earnings|loss)|statements? of profit/i,
    cash: /statements? of cash flows?/i,
};
const sections = {
    risks: /risk factors?/i, liquidity: /liquidity|capital resources/i,
    commitments: /commitments?|contingen/i, accounting: /accounting polic|accounting estimates/i,
    going_concern: /going concern|substantial doubt/i,
};
export type ComparisonSection = keyof typeof sections;
export const comparisonSections = Object.keys(sections);
function point(f: FilingFactRow) {
    return { ref: f.factId, amount: f.value, unit: f.unit, start: f.periodStart, end: f.periodEnd };
}
/** Compare columns of the same published statement. Group absolute ranks by currency/unit and reporting duration. */
export function financialMovers(snapshot: MaterialSnapshot) {
    const factsByTable = Map.groupBy(snapshot.facts, f => f.passageId);
    const mainDocuments = new Set(snapshot.documents.filter(doc => doc.filename === snapshot.filing.primaryDocument || /^EX-99/i.test(doc.type)).map(doc => doc.id));
    const moves = [];
    for (const table of snapshot.tables) {
        const statement = Object.entries(statements).find(([, pattern]) => pattern.test(table.title))?.[0];
        if (!statement || !mainDocuments.has(table.documentId))
            continue;
        const lines = Map.groupBy((factsByTable.get(table.anchor) ?? []).filter(f => f.row !== null && f.periodEnd && f.periodMonths !== null), f => JSON.stringify([f.row, f.concept, f.dimensions, f.unit, f.periodMonths]));
        for (const line of lines.values()) {
            const dates = line.sort((a, b) => b.periodEnd!.localeCompare(a.periodEnd!));
            const latest = dates[0]!;
            const prior = dates.find(f => f.periodEnd! < latest.periodEnd!);
            if (!prior || latest.value === prior.value)
                continue;
            const duration = latest.periodMonths!;
            const gapDays = (Date.parse(latest.periodEnd!) - Date.parse(prior.periodEnd!)) / 86400000;
            if (duration > 0 && (gapDays < 350 || gapDays > 380))
                continue;
            const delta = latest.value - prior.value;
            moves.push({ statement, durationMonths: duration, label: latest.label, table: table.anchor, url: table.sourceUrl, previous: point(prior), current: point(latest), delta,
                relative: prior.value > 0 && latest.value >= 0 ? delta / prior.value : null });
        }
    }
    return [...Map.groupBy(moves, r => JSON.stringify([r.statement, r.current.unit, r.durationMonths, r.current.end, r.previous.end])).values()].map(group => {
        const row = group[0]!;
        return { statement: row.statement, unit: row.current.unit, months: row.durationMonths, through: row.current.end, versus: row.previous.end,
            byAmount: group.toSorted((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 4),
            byPercent: group.filter(x => x.relative !== null).sort((a, b) => Math.abs(b.relative!) - Math.abs(a.relative!)).slice(0, 4) };
    });
}
function sectionBlocks(snapshot: MaterialSnapshot, section: ComparisonSection) {
    const pattern = sections[section];
    return snapshot.blocks.filter(b => b.kind === "paragraph" && b.filename === snapshot.filing.primaryDocument &&
        (pattern.test(b.path.join(" ")) || section === "going_concern" && pattern.test(b.text ?? "")));
}
/** A reading queue of changed paragraphs; a missing section never implies the issuer withdrew a risk. */
export async function filingChanges(env: Parameters<typeof sourceText>[0], current: MaterialSnapshot, prior: MaterialSnapshot | undefined, section: ComparisonSection, cursor: number) {
    const result = { section, current: current.ref, prior: prior?.ref ?? null };
    if (!prior)
        return { ...result, status: "no_prior_filing" };
    const before = sectionBlocks(prior, section), after = sectionBlocks(current, section);
    if (!before.length || !after.length)
        return { ...result, status: "section_not_comparable", before: before.length, after: after.length };
    const fingerprint = (b: MaterialSnapshot["blocks"][number]) => b.range?.sha256 || b.text?.replace(/\s+/g, " ").trim();
    const old = new Set(before.map(fingerprint));
    const changes = after.filter(b => !old.has(fingerprint(b)));
    const limit = 8;
    const references = await Promise.all(changes.slice(cursor, cursor + limit).map(async (b) => {
        const source = await sourceText(env, current, b.id);
        const matches = before.filter(other => other.title === b.title);
        return { anchor: b.id, title: b.title, url: b.sourceUrl, excerpt: source?.text.slice(0, 1600),
            comparisonCandidates: matches.slice(0, 3).map(other => ({ anchor: other.id, title: other.title, url: other.sourceUrl })) };
    }));
    return { ...result, status: "compared", paragraphsChanged: changes.length, references, nextCursor: cursor + limit < changes.length ? cursor + limit : null };
}
