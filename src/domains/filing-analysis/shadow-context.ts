import type { FrozenCompanyResearch } from "../public-research/contract.ts";
import { publicClaimUsable, validateExposure } from "../public-research/runtime.ts";
import type { ResearchContextState } from "../public-research/company/context-tools.ts";
import type { AnalysisEnv } from "../../operations.ts";
import { freezeCompanyResearch, companyExposureMappingStatus } from "../public-research/context.ts";
import { exposureBusinessMeaning, resolveCompanyExposure } from "../public-research/tag-exposure.ts";
import { readPublicResearch } from "../public-research/store.ts";
import { sha256 } from "../../lib/sha256.ts";

export type ShadowContextExtension = {
  parentContextHash: string; newContextHash: string; childContextAsOf: string;
  addedMappingVersions: string[];
  addedIndustryReports: Array<{ reportId: string; version: string; publishedAt: string }>;
};

/** An explicit new child information set: retain every parent ordinal and append only newly published industries. */
export async function appendPublishedShadowIndustry(env: AnalysisEnv, ticker: string, parent: FrozenCompanyResearch | undefined, state: ResearchContextState, asOf: string): Promise<{ context: FrozenCompanyResearch; audit: ShadowContextExtension }> {
  if (!parent || parent.ticker !== ticker) throw new Error("Published-industry continuation requires the parent's frozen company context");
  for (const use of state.researchUses ?? []) {
    if (use.decision !== "adopted") continue;
    if (!parent.reports.some(item => item.report.reportId === use.reportId && item.report.version === use.version && item.report.claims.some(claim => claim.id === use.claimId))) throw new Error("A previously adopted claim is absent from the parent context");
    const current = await readPublicResearch(env, use.reportId, { version: use.version, asOf });
    if (current.status !== "available" || !current.report || !publicClaimUsable(current.report, use.claimId) || Date.parse(current.report.publishedAt) > Date.parse(asOf)) throw new Error("A previously adopted parent claim is no longer published and valid at the child as-of time");
  }
  const fresh = await freezeCompanyResearch(env, ticker, asOf);
  if ((await companyExposureMappingStatus(env,ticker,parent.mappingVersions)).status!=="valid") throw new Error("Company exposure mapping changed; existing parent IDs and versions cannot be replaced or removed");
  const mappings = (await env.DB!.prepare("SELECT exposure_id,version,body_json FROM company_research_exposures WHERE company_id=? ORDER BY valid_from DESC,rowid DESC").bind(ticker).all<{ exposure_id: string; version: string; body_json: string }>()).results;
  const mappingFor = (version: string) => {
    const matches = mappings.filter(mapping => `${mapping.exposure_id}:${mapping.version}` === version);
    if (matches.length !== 1) throw new Error("Exposure mapping identity is missing or ambiguous");
    return matches[0]!;
  };
  const parentMappingIds = new Set(parent.mappingVersions.map(version => mappingFor(version).exposure_id));
  const addedMappingVersions = fresh.mappingVersions.filter(version => !parent.mappingVersions.includes(version)&&!parentMappingIds.has(mappingFor(version).exposure_id));
  const newMappingIndustryIds = new Set<string>();
  for (const version of addedMappingVersions) {
    const mapping = mappingFor(version), exposure = validateExposure(JSON.parse(mapping.body_json));
    if (parentMappingIds.has(exposure.id) || mapping.exposure_id !== exposure.id || mapping.version !== exposure.version || exposure.companyId !== ticker || exposure.status !== "verified") throw new Error("Only new verified exposure IDs can be appended to the parent mapping");
    if (Date.parse(exposure.validFrom) > Date.parse(asOf) || exposure.validUntil && Date.parse(exposure.validUntil) <= Date.parse(asOf) || [exposure.source.publishedAt, exposure.source.availableAt, exposure.source.collectedAt].some(time => Date.parse(time) > Date.parse(asOf)) || Date.parse(exposure.source.availableAt) < Date.parse(exposure.source.publishedAt) || await sha256(exposure.source.excerpt) !== exposure.source.contentHash) throw new Error("New exposure mapping requires original evidence, matching source hash and a non-future time basis");
    newMappingIndustryIds.add(exposure.industryId);
  }
  const mappingVersions = [...parent.mappingVersions, ...addedMappingVersions];
  const known = new Set(parent.reports.map(item => item.report.reportId));
  const additions: FrozenCompanyResearch["reports"] = [];
  for (const item of fresh.reports) {
    const report = item.report;
    if (report.type !== "industry" || known.has(report.reportId) || report.freshnessStatus !== "valid" || !report.claims.length || report.claims.some(claim => !publicClaimUsable(report, claim.id))) continue;
    if (Date.parse(report.publishedAt) > Date.parse(asOf) || Date.parse(report.asOf) > Date.parse(asOf) || Date.parse(report.generatedAt) > Date.parse(asOf) || Date.parse(report.validUntil) <= Date.parse(asOf)) continue;
    const exposures=[];
    for(const exposure of item.exposures){
      const parentPin=parent.mappingVersions.map(mappingFor).find(mapping=>mapping.exposure_id===exposure.id);
      if(parentPin&&parentPin.version!==exposure.version){
        const pinned=validateExposure(JSON.parse(parentPin.body_json));
        if(!exposure.tagBinding||exposureBusinessMeaning(pinned)!==exposureBusinessMeaning(exposure))throw new Error("Company exposure mapping changed; only a tag source enhancement may preserve a parent mapping pin");
        const family=mappings.filter(mapping=>mapping.exposure_id===exposure.id).map(mapping=>validateExposure(JSON.parse(mapping.body_json))),resolved=await resolveCompanyExposure(env,pinned,family,asOf);
        if(resolved.status!=="valid"||!resolved.exposure)throw new Error("Parent tag evidence requires review");
        exposures.push(resolved.exposure);
      }else exposures.push(exposure);
    }
    if (report.review.mode === "automatic" || report.review.conclusion !== "approved" || !exposures.length || exposures.some(exposure => exposure.industryId !== report.scope.industryId || !mappingVersions.includes(`${exposure.id}:${exposure.version}`))) continue;
    // freezeCompanyResearch supports historical reads. Admission specifically requires the current published version.
    const published = await env.DB!.prepare(`SELECT 1 ok FROM public_research_versions v JOIN public_research_reports r ON r.report_id=v.report_id
      WHERE v.report_id=? AND v.version=? AND v.state='published' AND r.current_version=v.version AND v.published_at<=?`)
      .bind(report.reportId, report.version, asOf).first();
    if (!published) continue;
    known.add(report.reportId);
    additions.push({...item,exposures});
  }
  if (!additions.length) throw new Error("No additional currently published, valid industry report matches the evidenced company mapping");
  const covered = new Set(additions.map(item => item.report.scope.industryId));
  const context: FrozenCompanyResearch = {
    ...parent, asOf, frozenAt: fresh.frozenAt, mappingVersions,
    reports: [...parent.reports, ...additions],
    gaps: [
      ...parent.gaps.filter(gap => !(gap.kind === "industry" && (gap.industryId && covered.has(gap.industryId) || addedMappingVersions.length && gap.industryId === null && gap.reason === "uncovered: no verified business exposure mapping"))),
      ...fresh.gaps.filter(gap => gap.kind === "industry" && gap.industryId && newMappingIndustryIds.has(gap.industryId)),
    ],
  };
  return { context, audit: { parentContextHash: await sha256(JSON.stringify(parent)), newContextHash: await sha256(JSON.stringify(context)), childContextAsOf: asOf, addedMappingVersions, addedIndustryReports: additions.map(({ report }) => ({ reportId: report.reportId, version: report.version, publishedAt: report.publishedAt })) } };
}
