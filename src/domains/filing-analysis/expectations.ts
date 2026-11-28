import type { MaterialRef, MaterialSnapshot, MaterialState } from "../filing-material/contract.ts";
import type { IndustryCategory } from "../business-map/classification-contract.ts";
import { INDUSTRY_CATEGORIES } from "../business-map/classification-contract.ts";
import { nodeText, parseHtml, type HtmlNode } from "../publishing/artifact-runtime/html.ts";
import { blockText } from "../publishing/artifact/document.ts";
import { readArtifactVersion } from "../publishing/artifact/store.ts";
import { listFilingMaterials, readMaterialSnapshot } from "../filing-material/store.ts";
import { releasePeriodEnd } from "../financials/runtime/earnings-release.ts";
import { sourceText } from "../filing-material/read.ts";
import type { SecFiling } from "./sec/sec.ts";
import type { AnalysisEnv } from "../../operations.ts";
import { ValuationStore } from "../valuation/store.ts";
const playbooks: Partial<Record<IndustryCategory, string>> = {
    cloud_infrastructure: "Separate contracted power from operating IT load, period-average utilization from period-end capacity, and investment outlays from commitments. Trace delivery, depreciation and financing covenants.",
    ai_compute: "Connect unit mix, utilization, inventory, capacity commitments and realized margins. Distinguish contracted volumes from delivered units.",
    semiconductors: "Check inventory days, utilization, mix, purchase commitments and the effect of under-absorption on gross profit.",
    enterprise_software: "Compare recurring revenue, retention, current RPO, duration, billings, SBC and net dilution when disclosed.",
    developer_tools: "Check usage versus contracted demand, retention, current RPO, hosting costs and dilution where disclosed.",
    productivity_software: "Check recurring growth, seat or price effects, current RPO and stock-based dilution.",
    networking_edge: "Compare traffic, paid adoption and contract conversion with infrastructure and network costs, cash investment and gross margin.",
    security: "Check customer retention, contract duration, RPO conversion and delivery costs when disclosed.",
    consumer_banking: "Check deposit costs, net interest margin, delinquency, loss provisions and regulatory capital.",
    commercial_banking: "Check credit quality, deposit mix, funding costs and capital adequacy.",
    retail_distribution: "Compare same-store growth, unit versus price effects, inventory turnover and promotional margins.",
};
export const disclosureCutoff = (filing: SecFiling) => filing.acceptedAt || filing.filingDate.slice(0, 10) + "T00:00:00.000Z";
type Ready = Extract<MaterialState, {
    status: "ready";
}>;
export function earlierMaterial(state: MaterialState, filing: SecFiling): state is Ready {
    return state.status === "ready" && state.filing.ticker === filing.ticker && state.ref.accession !== filing.accessionNumber && state.filing.filedAt.slice(0, 10) < filing.filingDate.slice(0, 10);
}
async function lastWatch(env: AnalysisEnv, filing: SecFiling, cutoff: string) {
    const row = await env.DB!.prepare(`SELECT v.artifact_id, v.version, v.hash, f.accession_number AS accession FROM sec_filings f
    JOIN analysis_artifacts a ON a.artifact_id='filing-report:'||f.ticker||':'||f.accession_number
    JOIN analysis_artifact_versions v ON v.artifact_id=a.artifact_id
    WHERE f.ticker=? AND f.form IN ('10-Q','10-K','20-F','40-F') AND f.filing_date<? AND f.accession_number<>?
    AND ((a.published_version=v.version AND a.published_hash=v.hash AND a.published_at<?) OR EXISTS
      (SELECT 1 FROM analysis_artifact_checks c WHERE c.artifact_id=v.artifact_id AND c.version=v.version
       AND c.stage='publication' AND c.created_at<? AND json_extract(c.result,'$.hash')=v.hash))
    ORDER BY f.report_date DESC,v.version DESC LIMIT 1`).bind(filing.ticker, filing.filingDate, filing.accessionNumber, cutoff, cutoff)
        .first<{
        artifact_id: string;
        accession: string;
        version: number;
        hash: string;
    }>();
    if (!row)
        return null;
    const stored = await readArtifactVersion(env, row.artifact_id, row.version);
    const watch = stored?.document.blocks.find(b => b.id === "what-to-watch");
    if (!watch || stored?.hash !== row.hash)
        return null;
    const items: string[] = [];
    const collect = (nodes: HtmlNode[]) => {
        for (const node of nodes)
            if (node.type === "element") {
                if (["li", "p", "tr"].includes(node.tag)) {
                    const statement = nodeText(node.children).trim();
                    if (statement)
                        items.push(statement);
                }
                else
                    collect(node.children);
            }
    };
    collect(parseHtml(watch.html).nodes);
    if (!items.length)
        items.push(blockText(watch.html));
    return { ref: "prior-watch-" + row.hash, accession: row.accession, version: row.version, hash: row.hash, items: items.map((text, i) => ({ id: "watch-" + (i + 1), text })) };
}
async function priorModel(env: AnalysisEnv, filing: SecFiling, cutoff: string) {
    const ref = await env.DB!.prepare("SELECT version_id FROM valuation_versions WHERE ticker=? AND report_status='ready' AND generated_at<? AND research_as_of<? ORDER BY generated_at DESC LIMIT 1").bind(filing.ticker, cutoff, cutoff).first<{
        version_id: string;
    }>();
    if (!ref)
        return null;
    const pub = await new ValuationStore(env.DB!).version(filing.ticker, ref.version_id);
    const base = pub?.model?.scenarios.base;
    if (!pub?.model || !base)
        return null;
    const accession = filing.accessionNumber.replaceAll("-", "");
    if (pub.evidence.some(e => e.documentId?.includes(filing.accessionNumber) || e.url?.includes("/" + accession + "/")))
        return null;
    return { ref: "prior-model-" + pub.versionId, source: "Spontra internal base case", version: pub.versionId, asOf: pub.researchAsOf, anchorPeriod: pub.financialPeriodEnd, modelType: pub.model.modelType,
        forecast: "Annual forecast periods in the published base scenario; compare quarterly results only when the basis permits.", drivers: { ...base.drivers, discountRate: pub.model.discountRate.components }, sourceIds: base.evidenceIds };
}
/** Date of the earnings period in the release itself. Its cover date is the disclosure event. */
export function earningsPeriod(snapshot: MaterialSnapshot) {
    const earningsDocs = new Set(snapshot.documents.filter(d => /^EX-99/i.test(d.type) || d.filename === snapshot.filing.primaryDocument).map(d => d.id));
    const text = snapshot.blocks.filter(b => earningsDocs.has(b.documentId) && b.kind === "paragraph" && b.text).map(b => b.text).join("\n");
    return releasePeriodEnd(text, snapshot.filing.filedAt);
}
export async function freezeFilingExpectations(env: AnalysisEnv, filing: SecFiling, current: MaterialSnapshot) {
    const asOf = disclosureCutoff(filing);
    const [materials, watch, model, tags] = await Promise.all([
        listFilingMaterials(env, filing.ticker), lastWatch(env, filing, asOf), priorModel(env, filing, asOf),
        env.DB!.prepare("SELECT DISTINCT sector FROM sec_business_tags WHERE ticker=? AND status='verified' AND updated_at<? ORDER BY sector").bind(filing.ticker, asOf).all<{
            sector: IndustryCategory;
        }>(),
    ]);
    const prior = materials.filter((m): m is Ready => earlierMaterial(m, filing)).sort((a, b) => b.filing.filedAt.localeCompare(a.filing.filedAt));
    const periodic = prior.find(m => m.filing.form.replace("/A", "") === current.filing.form.replace("/A", "")) ?? prior.find(m => /^(10-Q|10-K|20-F|40-F)$/.test(m.filing.form));
    const guidance: Array<{
        material: MaterialRef;
        anchor: string;
        url: string;
        text: string;
    }> = [];
    // The freshest completed earnings release with actual forward guidance. A later event-only 8-K cannot displace it.
    const subjectPeriod = /^(?:8-K|6-K)/.test(current.filing.form) ? earningsPeriod(current) : current.filing.reportDate;
    for (const release of prior.filter(m => /^(8-K|6-K)$/.test(m.filing.form))) {
        const snap = await readMaterialSnapshot(env, release.ref);
        const reportedPeriod = earningsPeriod(snap);
        if (!subjectPeriod || !reportedPeriod || reportedPeriod >= subjectPeriod)
            continue;
        const candidates = snap.blocks.filter(b => /^(?:EX-99|8-K|6-K)/i.test(snap.documents.find(d => d.id === b.documentId)?.type ?? "") &&
            /business outlook|financial outlook|guidance|we expect.*(?:revenue|income)|full.year outlook/i.test(b.title + " " + (b.text ?? "")));
        for (const block of candidates.slice(0, 14)) {
            const source = await sourceText(env, snap, block.id);
            if (source)
                guidance.push({ material: release.ref, anchor: block.id, url: source.url, text: source.text.slice(0, 1600) });
        }
        if (guidance.length)
            break;
    }
    const industry = tags.results.filter(t => Object.hasOwn(INDUSTRY_CATEGORIES, t.sector) && playbooks[t.sector]).map(t => ({ category: t.sector, questions: playbooks[t.sector]! }));
    return { asOf, guidance, watch, model, industry, comparison: periodic?.ref ?? null };
}
export type FilingExpectations = Awaited<ReturnType<typeof freezeFilingExpectations>>;
