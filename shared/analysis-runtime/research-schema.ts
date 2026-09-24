import { z } from "zod";
import { SEC_READER_CONTENT_BLOCK_SCHEMA } from "./sec-reader-schema.ts";

const short = z.string().min(1).max(500);
export const RESEARCH_SOURCE_SCHEMA = z.strictObject({
  id: z.string().min(1).max(180), title: short,
  url: z.string().url().max(2000).refine(value => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }),
  publishedAt: z.string().datetime().nullable(), retrievedAt: z.string().datetime(),
  kind: z.enum(["filing", "company", "news", "market", "other"]),
  excerpt: z.string().max(12000),
});

/** Investigation reports use the financial reader's exact block parser. */
export const RESEARCH_REPORT_SCHEMA = z.strictObject({
  version: z.literal("research.v1"), id: short, caseId: short,
  title: z.string().min(1).max(160), summary: z.string().min(1).max(1000),
  tickers: z.array(z.string().regex(/^[A-Z0-9.^=-]{1,20}$/)).min(1).max(30),
  generatedAt: z.string().datetime(), asOf: z.string().datetime(),
  trigger: z.enum(["baseline", "price", "filing", "news", "followup", "discovery"]),
  content: z.array(SEC_READER_CONTENT_BLOCK_SCHEMA).min(1).max(40),
  sources: z.array(RESEARCH_SOURCE_SCHEMA).min(1).max(40),
  hypotheses: z.array(z.strictObject({
    claim: short, mechanism: z.string().min(1).max(1500),
    tickers: z.array(z.string().max(20)).max(20),
    evidenceIds: z.array(z.string().max(180)).max(40),
    counterEvidence: z.string().min(1).max(1500),
    confidence: z.enum(["low", "medium", "high"]),
    nextCheck: short,
  })).max(8),
  followups: z.array(z.strictObject({ question: short, query: short, dueAt: z.string().datetime() })).max(5),
  limitations: z.array(short).max(12),
}).superRefine((report, ctx) => {
  const sources = new Set(report.sources.map(source => source.id));
  if (sources.size !== report.sources.length) ctx.addIssue({ code: "custom", message: "Duplicate source IDs" });
  const blocks = new Set<string>();
  report.content.forEach((block, index) => {
    if (blocks.has(block.blockId)) ctx.addIssue({ code: "custom", path: ["content", index], message: "Duplicate block ID" });
    blocks.add(block.blockId);
    // Research has no financial chart/asset manifest. Never invent a financial series.
    if (block.type === "chart" || block.type === "image") ctx.addIssue({ code: "custom", path: ["content", index], message: "Missing chart or asset manifest" });
    for (const id of block.evidenceIds) if (!sources.has(id)) ctx.addIssue({ code: "custom", path: ["content", index], message: `Unknown source ${id}` });
  });
  for (const hypothesis of report.hypotheses) for (const id of hypothesis.evidenceIds) {
    if (!sources.has(id)) ctx.addIssue({ code: "custom", message: `Unknown hypothesis source ${id}` });
  }
});

export type ResearchSource = z.infer<typeof RESEARCH_SOURCE_SCHEMA>;
export type ResearchReport = z.infer<typeof RESEARCH_REPORT_SCHEMA>;
