import { publicClaimUsable } from "../../../../shared/analysis-runtime/public-research.ts";
import type { FrozenCompanyResearch, ResearchDependency } from "../../../../shared/analysis-contract/public-research.ts";
import { registerSource, type ComposerState } from "../artifact/document.ts";
import { handTool } from "../pi/hand-tools.ts";
import type { AnyTool } from "../tools/registry.ts";

export type ResearchUse = ResearchDependency & { decision: "adopted" | "rejected" | "not_applicable"; reason: string; companySources: string[]; financialVariable: string };
export type ResearchContextState = { composer: ComposerState; publicResearchRead?: boolean; publicClaimsRead?: string[]; researchUses?: ResearchUse[] };
export const PUBLIC_RESEARCH_GUIDE = `Call read_public_research to inspect the frozen macro and industry context. It is a versioned background input, not a company fact. Record each claim you use with record_public_research_use, a company-specific exposure source, a financial variable and a reason for adopting, rejecting or finding it inapplicable. Missing or stale coverage is a concrete gap, never permission to substitute the nearest industry. Do not infer weights without evidence. Do not apply the same underlying shock twice through macro and industry layers. Public facts and company disclosures can disagree: preserve that conflict. All public versions remain frozen for this task; later updates require a new result version.`;

export function publicResearchTools<S extends ResearchContextState>(context: FrozenCompanyResearch | undefined, origin?: string): {
  tools: AnyTool<S>[]; read(id: string): { title: string; text: string } | null; precheck(state: S): string | null;
} {
  const textById = new Map<string, { title: string; text: string }>();
  context?.reports.forEach(({ report }, i) => report.claims.forEach((claim, j) => textById.set(`public${i + 1}c${j + 1}`, { title: `${report.title}: ${claim.title}`, text: JSON.stringify({ reportId: report.reportId, version: report.version, asOf: report.asOf, claim, sources: report.sources.filter(source => claim.sourceIds.includes(source.id)), observations: report.observations.filter(observation => claim.observationIds.includes(observation.id)) }) })));
  return {
    read: id => textById.get(id) ?? null,
    precheck: state => {
      if (context && !state.publicResearchRead) return "Read the frozen public research and explicitly acknowledge its coverage gaps before publishing.";
      for (const [i, item] of (context?.reports ?? []).entries()) {
        for (const [j, claim] of item.report.claims.entries()) if (state.composer.blocks.some(block => block.sources.includes(`public${i + 1}c${j + 1}`)) && !(state.researchUses ?? []).some(use => use.reportId === item.report.reportId && use.version === item.report.version && use.claimId === claim.id)) return `Record company-specific applicability before citing public claim ${item.report.reportId}/${claim.id}.`;
      }
      return null;
    },
    tools: [
      handTool<S>({ name: "read_public_research", description: "Inspect pinned macro/industry versions and coverage gaps. No arguments lists claim titles; reportId plus claimId reads a claim with all of its original source excerpts and observations. No generation or refresh.", input_schema: { type: "object", properties: { reportId: { type: "string" }, claimId: { type: "string" } }, required: [] } }, (args, state) => {
        state.publicResearchRead = true;
        if (!context) return { observation: JSON.stringify({ status: "unavailable", reason: "This task predates frozen public research. Do not add current background to an older checkpoint." }) };
        state.composer.researchContext ??= { asOf: context.asOf, mappingVersions: context.mappingVersions, reports: context.reports.map(({ report }) => ({ reportId: report.reportId, version: report.version, title: report.title, asOf: report.asOf, type: report.type, scope: report.scope.description })), gaps: context.gaps, uses: state.researchUses ?? [] };
        if (!args.reportId) return { observation: JSON.stringify({ ...context, reports: context.reports.map(({ report, exposures }, i) => ({ sourceId: `public${i + 1}`, reportId: report.reportId, version: report.version, title: report.title, scope: report.scope, asOf: report.asOf, freshnessStatus: report.freshnessStatus, exposures, claims: report.claims.map(claim => ({ id: claim.id, kind: claim.kind, title: claim.title })) })) }) };
        const index = context.reports.findIndex(r => r.report.reportId === args.reportId);
        const report = context.reports[index]?.report;
        const claim = report?.claims.find(c => c.id === args.claimId);
        if (!report || !claim) return { observation: "Choose a reportId and claimId from the frozen index.", error: true };
        const sourceId = `public${index + 1}c${report.claims.indexOf(claim) + 1}`;
        registerSource(state.composer, sourceId, { title: `${report.title} (${report.asOf}, ${report.version})`, url: origin?.startsWith("https://") ? `${origin.replace(/\/$/, "")}/research/${encodeURIComponent(report.reportId)}?version=${encodeURIComponent(report.version)}#claim-${encodeURIComponent(claim.id)}` : null, kind: "data" });
        state.publicClaimsRead = [...new Set([...(state.publicClaimsRead ?? []), `${report.reportId}:${report.version}:${claim.id}`])];
        return { observation: JSON.stringify({ sourceId, reportId: report.reportId, version: report.version, scope: report.scope, asOf: report.asOf, freshnessStatus: report.freshnessStatus, claim, sources: report.sources.filter(source => claim.sourceIds.includes(source.id)), observations: report.observations.filter(observation => claim.observationIds.includes(observation.id)) }) };
      }),
      handTool<S>({ name: "record_public_research_use", description: "Record company-specific applicability of a frozen public claim, including rejection/non-applicability. Adopted claims need registered company evidence and cannot reuse one shock/financial-variable channel twice.", input_schema: { type: "object", properties: {
        reportId: { type: "string" }, version: { type: "string" }, claimId: { type: "string" }, decision: { type: "string", enum: ["adopted", "rejected", "not_applicable"] }, reason: { type: "string" }, companySources: { type: "array", items: { type: "string" } }, financialVariable: { type: "string" },
      }, required: ["reportId", "version", "claimId", "decision", "reason", "companySources", "financialVariable"] } }, (args, state) => {
        const report = context?.reports.find(r => r.report.reportId === args.reportId && r.report.version === args.version)?.report;
        const claim = report?.claims.find(c => c.id === args.claimId);
        const decision = args.decision;
        const companySources = Array.isArray(args.companySources) ? args.companySources.filter((s): s is string => typeof s === "string") : [];
        const reason = typeof args.reason === "string" ? args.reason.trim() : "";
        const variable = typeof args.financialVariable === "string" ? args.financialVariable.trim() : "";
        if (!report || !claim || !(state.publicClaimsRead ?? []).includes(`${report?.reportId}:${report?.version}:${claim?.id}`) || !reason || !variable || !["adopted", "rejected", "not_applicable"].includes(String(decision))) return { observation: "Unknown frozen claim, decision or missing applicability explanation.", error: true };
        if (decision === "adopted" && (!publicClaimUsable(report, claim.id) || !companySources.length || companySources.some(id => !state.composer.sources[id] || id.startsWith("public")))) return { observation: "Adoption requires a valid public version and registered company-specific evidence. Stale research remains a gap.", error: true };
        const uses = state.researchUses ??= [];
        if (decision === "adopted" && uses.some(use => use.decision === "adopted" && use.financialVariable === variable && !(use.reportId === report.reportId && use.claimId === claim.id) && context?.reports.find(r => r.report.reportId === use.reportId)?.report.claims.find(c => c.id === use.claimId)?.shockId === claim.shockId)) return { observation: "Duplicate shock for this financial variable. Explain and combine overlapping channels instead of applying the same shock twice.", error: true };
        state.researchUses = [...uses.filter(use => !(use.reportId === report.reportId && use.claimId === claim.id)), { reportId: report.reportId, version: report.version, claimId: claim.id, decision: decision as ResearchUse["decision"], reason, companySources, financialVariable: variable }];
        if (state.composer.researchContext) state.composer.researchContext.uses = state.researchUses;
        return { observation: "Applicability recorded against the frozen version." };
      }),
    ],
  };
}
