import type { PublicResearchDraft, ResearchReview, PublicReportVersion, PublicReportSummary, ResearchFreshness, CompanyResearchExposure } from "./contract.ts";
import { publicResearchDraftSchema, companyResearchExposureSchema, publicResearchListSchema, publicResearchReadSchema } from "./schema.ts";

export function validatePublicResearchDraft(input: unknown, now: string): PublicResearchDraft {
  const report = publicResearchDraftSchema.parse(input);
  const fail = (message: string): never => { throw new Error(`Public research rejected: ${message}`); };
  const time = Date.parse(now);
  if (!Number.isFinite(time)) fail("invalid validation time");
  if (Date.parse(report.asOf) > time || Date.parse(report.generatedAt) > time) fail("future report");
  if (Date.parse(report.validUntil) <= Date.parse(report.asOf)) fail("invalid validity window");
  if (report.type === "industry" && !report.scope.industryId) fail("industry identity missing");
  if (report.type === "macro" && report.scope.industryId) fail("macro cannot claim a single industry scope");
  if (report.coverage === "limited" && !report.missingInputs.length) fail("limited coverage requires specific gaps");
  const unique = <T extends { id: string }>(items: T[], kind: string) => {
    const map = new Map(items.map(item => [item.id, item]));
    if (map.size !== items.length) fail(`duplicate ${kind} identity`);
    return map;
  };
  const sources = unique(report.sources, "source"), observations = unique(report.observations, "observation"), claims = unique(report.claims, "claim");
  const canonical = new Set<string>();
  for (const source of sources.values()) {
    const key = `${source.canonicalId}:${source.revision}:${source.locator}:${source.contentHash}`;
    if (canonical.has(key)) fail("duplicate original excerpt presented as independent evidence");
    canonical.add(key);
    if (Date.parse(source.availableAt) > Date.parse(report.asOf) || Date.parse(source.publishedAt) > Date.parse(report.asOf)) fail(`future source ${source.id}`);
    if (Date.parse(source.collectedAt) > time || Date.parse(source.availableAt) < Date.parse(source.publishedAt)) fail(`invalid source chronology ${source.id}`);
    if (source.observationPeriod.start > source.observationPeriod.end) fail(`invalid source period ${source.id}`);
  }
  for (const observation of observations.values()) {
    if (!sources.has(observation.sourceId)) fail(`unknown source ${observation.sourceId}`);
    if (observation.period.start > observation.period.end) fail(`invalid period ${observation.id}`);
    if (observation.basis === "actual" && observation.period.end > report.asOf.slice(0,10)) fail(`future actual observation ${observation.id}`);
    if (observation.status === "observed" ? observation.value === null : observation.value !== null) fail(`missing and zero conflated ${observation.id}`);
    if (observation.status !== "observed" && !observation.missingReason) fail(`missing reason ${observation.id}`);
    const unitCurrency = /^(USD|EUR|GBP|JPY|CNY)(?:_|$)/.exec(observation.unit)?.[1];
    if (unitCurrency && observation.currency !== unitCurrency) fail(`unit/currency mismatch ${observation.id}`);
  }
  for (const claim of claims.values()) {
    if (claim.sourceIds.some(source => !sources.has(source))) fail(`unknown source in ${claim.id}`);
    if (claim.observationIds.some(obs => !observations.has(obs))) fail(`unknown observation in ${claim.id}`);
    if (claim.premiseClaimIds.some(premise => !claims.has(premise) || premise === claim.id)) fail(`unknown/self premise in ${claim.id}`);
    if (claim.kind !== "fact" && (!claim.assumptions.length || !claim.premiseClaimIds.length)) fail(`inference/scenario requires assumptions and premises: ${claim.id}`);
    for (const obsId of claim.observationIds) if (!claim.sourceIds.includes(observations.get(obsId)!.sourceId)) fail(`observation source omitted in ${claim.id}`);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => { if (visiting.has(id)) fail("claim dependency cycle"); if (visited.has(id)) return; visiting.add(id); for (const parent of claims.get(id)!.premiseClaimIds) visit(parent); visiting.delete(id); visited.add(id); };
  for (const id of claims.keys()) visit(id);
  const sectionClaims = report.sections.flatMap(section => section.claimIds);
  if (sectionClaims.some(id => !claims.has(id)) || [...claims.keys()].some(id => !sectionClaims.includes(id))) fail("sections must cover every claim and reference existing claims");
  for (const scenario of report.scenarios) if (scenario.claimIds.some(id => !claims.has(id))) fail("scenario references unknown claim");
  if (report.dependencies.some(dep => dep.reportId === report.reportId)) fail("self report dependency");
  if (report.dependencies.some(dep => dep.ownerClaimIds.some(id => !claims.has(id)))) fail("public dependency references unknown owner claim");
  return report;
}

export function validatePublicResearch(input: unknown, review: ResearchReview, now: string): PublicResearchDraft {
  const report = validatePublicResearchDraft(input, now);
  const fail = (message: string): never => { throw new Error(`Public research rejected: ${message}`); };
  const time = Date.parse(now);
  const claims = new Map(report.claims.map(claim => [claim.id, claim]));
  if (review.mode === "automatic" && report.type !== "macro") fail("automatic review is permitted only for macro reports");
  if (review.conclusion !== "approved" || review.reviewer === report.authorRunId || review.authorRunId !== report.authorRunId || !review.reviewer.trim() || !review.notes.trim()) fail("independent review required");
  if (!Number.isFinite(Date.parse(review.reviewedAt)) || Date.parse(review.reviewedAt) < Date.parse(report.generatedAt) || Date.parse(review.reviewedAt) > time) fail("invalid review time");
  const reviewed = new Map(review.claimChecks.map(check => [check.claimId, check]));
  if (reviewed.size !== claims.size || review.claimChecks.length !== claims.size || [...claims.keys()].some(id => !reviewed.get(id)?.supported || !reviewed.get(id)?.notes.trim())) fail("every claim needs an independent supporting-evidence review");
  return report;
}

export function validateExposure(input: unknown): CompanyResearchExposure {
  const exposure = companyResearchExposureSchema.parse(input);
  if (exposure.weight !== null && (!exposure.weightBasis || exposure.relation === "background")) throw new Error("Exposure weight requires a financial basis");
  if (exposure.validUntil && exposure.validUntil <= exposure.validFrom) throw new Error("Invalid exposure validity");
  return exposure;
}
export function researchFreshness(report: Pick<PublicReportVersion, "validUntil" | "freshnessStatus">, now: string): ResearchFreshness {
  if (["review_required", "unavailable", "updating"].includes(report.freshnessStatus)) return report.freshnessStatus;
  return Date.parse(report.validUntil) <= Date.parse(now) ? "stale" : report.freshnessStatus;
}
export function publicReportSummary(report: PublicReportVersion): PublicReportSummary {
  const { reportId, version, type, title, language, scope, asOf, publishedAt, freshnessStatus, coverage, summary, changes } = report;
  return { reportId, version, type, title, language, scope, asOf, publishedAt, freshnessStatus, coverage, summary, changes };
}
/** Same upstream shock and financial variable may be adopted only once, even through two reports. */
export function distinctImpactChannels(reports: PublicReportVersion[]) {
  const seen = new Map<string, { reportId: string; version: string; claimId: string }>();
  const duplicates: Array<{ key: string; first: { reportId: string; version: string; claimId: string }; repeated: { reportId: string; version: string; claimId: string } }> = [];
  for (const report of reports) for (const claim of report.claims) {
    const key = `${claim.shockId}:${claim.financialVariable}`;
    const reference = { reportId: report.reportId, version: report.version, claimId: claim.id };
    const first = seen.get(key); if (first) duplicates.push({ key, first, repeated: reference }); else seen.set(key, reference);
  }
  return { channels: [...seen.entries()].map(([key, reference]) => ({ key, ...reference })), duplicates };
}

export function parsePublicResearchList(value:unknown):import("./contract.ts").PublicResearchList|null{
  const parsed=publicResearchListSchema.safeParse(value);return parsed.success?parsed.data:null;
}
export function parsePublicResearchRead(value:unknown):import("./contract.ts").PublicResearchRead|null{
  const parsed=publicResearchReadSchema.safeParse(value);return parsed.success?parsed.data:null;
}

/** Distinct excerpts remain locatable, but one original/revision is still one evidence group. */
export function canonicalResearchEvidence(report:PublicResearchDraft){
  const groups=new Map<string,string[]>();
  for(const source of report.sources){const key=`${source.canonicalId}:${source.revision}`;const ids=groups.get(key)??[];ids.push(source.id);groups.set(key,ids);}
  return [...groups].map(([canonicalKey,sourceIds])=>({canonicalKey,sourceIds}));
}

export function publicClaimUsable(report:PublicReportVersion,claimId:string):boolean{
  return !["stale","unavailable"].includes(report.freshnessStatus) && report.claimStates[claimId]==="valid";
}
