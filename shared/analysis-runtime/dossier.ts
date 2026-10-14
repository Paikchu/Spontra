import { z } from "zod";
import type { DossierPublication } from "../analysis-contract/dossier.ts";
import type { FindingsPublication } from "../analysis-contract/findings.ts";
import { findingsMaterialSchema, readLensDocument } from "./findings.ts";

const dossierSchema = z.object({
  schemaVersion: z.literal("dossier.v1"), ticker: z.string().regex(/^[A-Z][A-Z0-9.-]{0,11}$/), findingsFingerprint: z.string().min(1).max(128), fingerprint: z.string().min(1).max(128),
  generatedAt: z.string().max(40), model: z.string().min(1).max(80), documents: z.record(z.string().max(80), z.unknown()), materials: z.array(findingsMaterialSchema).max(120),
});

/** A dossier through the contract: each document is read on its own, so one malformed document does not void the rest. */
export function readDossierPublication(value: unknown, ticker: string): DossierPublication | null {
  const parsed = dossierSchema.safeParse(value);
  if (!parsed.success || parsed.data.ticker !== ticker) return null;
  const documents: DossierPublication["documents"] = {};
  for (const [id, doc] of Object.entries(parsed.data.documents)) { const read = readLensDocument(doc); if (read) documents[id] = read; }
  return Object.keys(documents).length ? { ...parsed.data, documents } : null;
}

/**
 * The findings with the analyst's documents in place of their own, when the dossier was written for exactly this
 * publication. Materials merge by id; the dossier's win. Anything else about the findings is untouched.
 */
export function mergeDossier(findings: FindingsPublication, dossier: DossierPublication | null): FindingsPublication {
  if (!dossier || !findings.fingerprint || dossier.findingsFingerprint !== findings.fingerprint) return findings;
  const materials = new Map((findings.materials ?? []).map(m => [m.id, m]));
  for (const m of dossier.materials) materials.set(m.id, m);
  return {
    ...findings,
    findings: findings.findings.map(f => dossier.documents[f.id] ? { ...f, lens: { type: "document" as const, document: dossier.documents[f.id]! } } : f),
    materials: [...materials.values()],
  };
}
