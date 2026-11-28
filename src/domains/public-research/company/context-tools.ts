import { publicClaimUsable } from "../runtime.ts";
import type { FrozenCompanyResearch, ResearchDependency } from "../contract.ts";
import type { ArtifactResearchContext } from "../../publishing/artifact-contract.ts";
import { registerSource, type ComposerState } from "../../publishing/artifact/document.ts";
import { handTool } from "../../../ai/pi/hand-tools.ts";
import type { AnyTool } from "../../../ai/tools/registry.ts";

export type ResearchUse = ResearchDependency & { decision: "adopted" | "rejected" | "not_applicable"; reason: string; companySources: string[]; financialVariable: string };
export type ResearchContextState = { composer: ComposerState; publicResearchRead?: boolean; publicClaimsRead?: string[]; researchUses?: ResearchUse[] };
export const PUBLIC_RESEARCH_GUIDE = `Call read_public_research to inspect the frozen macro and industry context. It is a versioned background input, not a company fact. For every frozen report, read a relevant claim and record at least one adopted, rejected or not_applicable decision with a concrete company-specific reason using record_public_research_use; reading the index alone is insufficient. Record each claim you use with a company-specific exposure source and a financial variable. You do not have to adopt any claim or assess every claim in a report. Missing or stale coverage is a concrete gap, never permission to substitute the nearest industry. Do not infer weights without evidence. Do not apply the same underlying shock twice through macro and industry layers. Public facts and company disclosures can disagree: preserve that conflict. All public versions remain frozen for this task; later updates require a new result version.`;

export const isPublicResearchSourceId = (id: string): boolean => /^public\d+c\d+$/.test(id);
type PublicSourceBinding = { source?: { url: string | null } | null; researchContext?: Pick<ArtifactResearchContext, "reports"> };
/** Reconstruct only the task's frozen ordinal/claim. A stored citation must still name that exact report version. */
export function frozenPublicResearchSource(context: FrozenCompanyResearch | undefined, id: string, binding?: PublicSourceBinding): { title: string; text: string } | null {
  const match = /^public([1-9]\d*)c([1-9]\d*)$/.exec(id);
  if (!match) return null;
  const reportIndex = Number(match[1]) - 1, claimIndex = Number(match[2]) - 1;
  const report = context?.reports[reportIndex]?.report, claim = report?.claims[claimIndex];
  if (!report || !claim) return null;
  if (binding) {
    const recorded = binding.researchContext?.reports[reportIndex];
    if (!binding.source || recorded?.reportId !== report.reportId || recorded.version !== report.version) return null;
    if (binding.source.url !== null) {
      try {
        const url = new URL(binding.source.url);
        if (!url.pathname.endsWith(`/research/${encodeURIComponent(report.reportId)}`) || url.searchParams.get("version") !== report.version || url.hash !== `#claim-${encodeURIComponent(claim.id)}`) return null;
      } catch { return null; }
    }
  }
  return { title: `${report.title}: ${claim.title}`, text: JSON.stringify({ reportId: report.reportId, version: report.version, asOf: report.asOf, claim, sources: report.sources.filter(source => claim.sourceIds.includes(source.id)), observations: report.observations.filter(observation => claim.observationIds.includes(observation.id)) }) };
}

export function publicResearchTools<S extends ResearchContextState>(context: FrozenCompanyResearch | undefined, origin?: string): {
  tools: AnyTool<S>[]; read(id: string): { title: string; text: string } | null; precheck(state: S): string | null;
} {
  return {
    read: id => frozenPublicResearchSource(context, id),
    precheck: state => {
      if (context && !state.publicResearchRead) return "Read the frozen public research and explicitly acknowledge its coverage gaps before publishing.";
      for (const [i, item] of (context?.reports ?? []).entries()) {
        const uses = (state.researchUses ?? []).filter(use => use.reportId === item.report.reportId && use.version === item.report.version && item.report.claims.some(claim => claim.id === use.claimId) && ["adopted", "rejected", "not_applicable"].includes(use.decision) && use.reason.trim());
        if (!uses.length) return `Record at least one adopted, rejected or not_applicable claim decision with a concrete company-specific reason for frozen public report ${item.report.reportId} (${item.report.version}) before publishing.`;
        for (const [j, claim] of item.report.claims.entries()) if (state.composer.blocks.some(block => block.sources.includes(`public${i + 1}c${j + 1}`)) && !uses.some(use => use.claimId === claim.id)) return `Record company-specific applicability before citing public claim ${item.report.reportId}/${claim.id}.`;
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
      handTool<S>({ name: "record_public_research_use", description: "Record company-specific applicability of a frozen public claim with a concrete reason. At least one adopted/rejected/not_applicable decision is required per frozen report. Adopted claims need registered company evidence and cannot reuse one shock/financial-variable channel twice.", input_schema: { type: "object", properties: {
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
