import { z } from "zod";

const text = z.string().trim().min(1);
const id = text.regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const timestamp = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString());
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().startsWith(value), "Invalid calendar date");
export const researchFreshnessSchema = z.enum(["valid", "updating", "review_required", "stale", "unavailable"]);
export const sourceSnapshotSchema = z.object({
  id, canonicalId: text, uri: z.string().url().startsWith("https://"), title: text, locator: text,
  excerpt: text, contentHash: text.regex(/^[a-f0-9]{64}$/), revision: text,
  publishedAt: timestamp, availableAt: timestamp, collectedAt: timestamp,
  observationPeriod: z.object({ start: date, end: date }),
  usage: z.enum(["public", "licensed"]), authorization: text,
});
export const observationSchema = z.object({
  id, sourceId: id, label: text, status: z.enum(["observed", "missing", "not_applicable"]),
  value: z.number().finite().nullable(), unit: text, currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  period: z.object({ start: date, end: date }), definition: text,
  basis: z.enum(["actual", "consensus", "management", "assumption"]), missingReason: text.nullable(),
});
export const researchClaimSchema = z.object({
  id, kind: z.enum(["fact", "inference", "scenario"]), title: text, statement: text,
  sourceIds: z.array(id).min(1), observationIds: z.array(id), premiseClaimIds: z.array(id),
  assumptions: z.array(text), impactChannels: z.array(text).min(1),
  counterEvidence: z.array(text).min(1), verification: text,
  shockId: id, financialVariable: text,
});
export const researchDependencySchema = z.object({ reportId: id, version: id, claimId: id });
export const publicResearchDependencySchema = researchDependencySchema.extend({ ownerClaimIds: z.array(id).min(1) });
export const publicResearchDraftSchema = z.object({
  schemaVersion: z.literal("public-research.v1"), reportId: id, type: z.enum(["macro", "industry"]),
  title: text, language: z.enum(["en", "zh-CN"]),
  scope: z.object({ regions: z.array(text).min(1), currency: z.string().regex(/^[A-Z]{3}$/), industryId: id.nullable(), description: text }),
  asOf: timestamp, generatedAt: timestamp, validUntil: timestamp,
  inputFingerprint: text.regex(/^[a-f0-9]{64}$/), modelVersion: text, promptVersion: text, toolVersion: text,
  coverage: z.enum(["complete", "limited"]), missingInputs: z.array(text), changes: z.array(text).min(1),
  summary: text, sources: z.array(sourceSnapshotSchema).min(1), observations: z.array(observationSchema),
  claims: z.array(researchClaimSchema).min(1), dependencies: z.array(publicResearchDependencySchema),
  scenarios: z.array(z.object({ name: z.enum(["downside", "base", "upside"]), assumptions: z.array(text).min(1), claimIds: z.array(id).min(1) })).min(1),
  authorRunId: text,
  sections: z.array(z.object({ id, title: text, claimIds: z.array(id).min(1) })).min(1),
});

export const companyResearchExposureSchema = z.object({
  id, version: id, companyId: text, segmentId: text.nullable(), industryId: id,
  relation: z.enum(["industry", "supplier", "customer", "financing", "energy", "background"]),
  regions: z.array(text).min(1), validFrom: timestamp, validUntil: timestamp.nullable(),
  source: sourceSnapshotSchema, weight: z.number().min(0).max(1).nullable(),
  weightBasis: text.nullable(), status: z.enum(["verified", "disputed"]),
});
export const researchReviewSchema = z.object({
  reviewer: text, reviewedAt: timestamp, authorRunId: text,
  claimChecks: z.array(z.object({ claimId: id, supported: z.boolean(), notes: text })),
  conclusion: z.enum(["approved", "rejected"]), notes: text,
});
export const publicReportVersionSchema = publicResearchDraftSchema.extend({
  version: id, publishedAt: timestamp, supersedes: id.nullable(), freshnessStatus: researchFreshnessSchema,
  review: researchReviewSchema, bodyMarkdown: text,
  claimStates: z.record(z.string(), z.enum(["valid", "review_required", "unavailable"])),
});
export const publicReportSummarySchema = publicReportVersionSchema.pick({
  reportId:true,version:true,type:true,title:true,language:true,scope:true,asOf:true,publishedAt:true,
  freshnessStatus:true,coverage:true,summary:true,changes:true,
});
export const publicResearchListSchema = z.object({status:z.enum(["ready","unavailable"]),reports:z.array(publicReportSummarySchema),reason:text.optional()});
export const publicResearchReadSchema = z.object({status:z.enum(["available","unavailable","withdrawn"]),report:publicReportVersionSchema.nullable(),history:z.array(publicReportSummarySchema),reason:text.optional()})
  .refine(value=>value.status==='available'?value.report!==null:value.report===null,"Report status and body disagree");
