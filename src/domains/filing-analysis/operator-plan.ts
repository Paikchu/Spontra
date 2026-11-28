import { z } from "zod";
import { PERIODIC_BLOCKS } from "./periodic.ts";

const text=z.string().trim().min(1),hash=z.string().regex(/^[a-f0-9]{64}$/),computed=z.string().regex(/^c[1-9]\d*$/);
const reference=z.string().min(1).max(200);
const chain=z.object({id:text,priorAssumption:text,newEvidence:text,revisedAssumption:text,financialEffect:text,valuationEffect:text,quantificationStatus:z.enum(["quantifiable","sensitivity_only","not_quantifiable"]),sourceIds:z.array(reference).min(1),computationRefs:z.array(reference),missingInputs:z.array(text),counterEvidence:text,verification:text,window:text}).strict();
const researchUse=z.object({reportId:text,version:text,claimId:text,decision:z.enum(["adopted","rejected","not_applicable"]),reason:text,companySources:z.array(reference),financialVariable:text}).strict();
const materialRead=z.discriminatedUnion("tool",[
  z.object({tool:z.literal("read_filing_markdown"),args:z.object({accession:text.optional(),anchor:text.optional(),cursor:text.optional(),maxChars:z.number().int().min(1000).max(48000).optional()}).strict()}).strict(),
  z.object({tool:z.literal("find_filing_tables"),args:z.object({accession:text.optional(),name:text.optional(),description:text.optional(),cursor:text.optional(),limit:z.number().int().min(1).max(30).optional()}).strict()}).strict(),
  z.object({tool:z.literal("read_filing_table"),args:z.object({accession:text.optional(),tableId:text,cursor:text.optional(),rows:z.number().int().min(1).max(250).optional()}).strict()}).strict(),
  z.object({tool:z.literal("query_facts"),args:z.object({label:text.optional(),periodEnd:text.optional(),months:z.number().int().min(0).max(12).optional(),anchor:text.optional()}).strict()}).strict(),
]);

/** A single externally authored, bounded correction plan; no client state or review receipts are accepted. */
export const filingOperatorPlanSchema=z.object({
  schemaVersion:z.literal("filing-operator-plan.v1"),
  sourceRunId:z.string().regex(/^shadow-[A-Z0-9.-]+-\d{10}-\d{2}-\d{6}-[A-Za-z0-9-]+$/),
  expectedCheckpointHash:hash,expectedPublicVersion:z.number().int().positive().nullable(),expectedPublicHash:hash.nullable(),
  author:z.object({model:z.literal("gpt-6.1-sol"),effort:z.literal("max"),runId:text.max(200),promptVersion:text.max(200)}).strict(),
  reason:text.max(8000),
  pinnedReads:z.array(materialRead).max(24).default([]),
  computeCalls:z.array(z.object({expectedResultId:computed,args:z.object({label:text.max(160),formula:text.max(4000),unit:text.max(40)}).strict(),expected:z.object({value:z.number().finite(),unit:text,tolerance:z.number().finite().min(0).max(0.01).default(0)}).strict().optional()}).strict()).max(64),
  oldToNew:z.record(computed,computed),
  evidenceCorrections:z.array(z.object({id:z.string().regex(/^E[1-9]\d*$/),expectedOldHash:hash,section:reference,quote:text.max(600),statement:text.max(400),facts:z.array(reference).max(8).default([])}).strict()).max(24).default([]),
  closeLeads:z.object({leads:z.array(z.object({id:z.string().regex(/^L[1-9]\d*$/),verdict:z.enum(["highlight","risk","nothing unusual","open"]),finding:text.max(600),evidence:z.array(reference)}).strict()).max(32)}).strict().default({leads:[]}),
  researchUses:z.array(researchUse).max(24).default([]),
  investmentChains:z.array(chain).min(1).max(8),
  charts:z.array(z.object({id:text.max(80),title:text.max(200),type:z.enum(["bar","line"]),aspect:z.enum(["wide","square"]).optional(),months:z.number().int().min(1).max(12).optional(),series:z.array(z.object({label:text.max(160),points:z.array(z.object({period:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),ref:reference}).strict()).min(2).max(16)}).strict()).min(1).max(8)}).strict()).max(8).default([]),
  blocks:z.array(z.object({id:z.enum(PERIODIC_BLOCKS),html:text.max(80000),title:text.optional(),sources:z.array(reference).optional()}).strict()).length(PERIODIC_BLOCKS.length),
}).strict().superRefine((plan,ctx)=>{
  if(new Set(plan.blocks.map(block=>block.id)).size!==PERIODIC_BLOCKS.length)ctx.addIssue({code:"custom",message:"Every original periodic block must appear exactly once",path:["blocks"]});
  if((plan.expectedPublicVersion===null)!==(plan.expectedPublicHash===null))ctx.addIssue({code:"custom",message:"Public version/hash must both be null or both exact",path:["expectedPublicHash"]});
  const ids=new Set(plan.computeCalls.map(call=>call.expectedResultId));
  if(ids.size!==plan.computeCalls.length||Object.entries(plan.oldToNew).some(([old,next])=>old===next||!ids.has(next)))ctx.addIssue({code:"custom",message:"Every old-to-new target must be a distinct actual compute result declared by this plan",path:["oldToNew"]});
});
export type FilingOperatorPlan=z.infer<typeof filingOperatorPlanSchema>;
export const stableOperatorValue=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==="object"&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
