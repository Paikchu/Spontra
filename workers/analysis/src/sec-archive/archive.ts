import { archiveFilingDisclosures, readArchivedDocument } from "../financial-data/disclosure-audit.ts";
import { withFilingStructure } from "../financial-data/presentation.ts";
import type { DocumentSource } from "../financial-data/parser.ts";
import { canonicalSecHtml, type SecReader } from "../financial-data/provider.ts";
import type { AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { edgarDocumentReader, type GatewayOptions } from "./gateway.ts";

/** What the archive needs: the pointers in D1 and the documents in R2. */
export type ArchiveEnv = { DB: D1Database; SEC_FILINGS: AnalysisEnv["SEC_FILINGS"]; SEC_USER_AGENT: string };

export type ArchivedDocument = {
  url: string;
  filename: string;
  type: string;
  role: "primary" | "exhibit";
  html: string;
};
type ArchivedFiling = { ticker: string; accession: string; form: string; filedAt: string; reportDate: string; complete: boolean; documents: ArchivedDocument[] };

const fileOf = (url: string) => decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
export async function archiveHolds(env: ArchiveEnv, ticker: string, accession: string, primaryUrl?: string): Promise<boolean> {
  const { getFilingMaterial } = await import("../filing-material/index.ts");
  const material = await getFilingMaterial(env, ticker, accession);
  return material?.status === "ready" && (!primaryUrl || material.filing.documentUrl === primaryUrl);
}

export async function archivedFiling(env: ArchiveEnv, ticker: string, accession: string, primaryUrl?: string): Promise<ArchivedFiling | null> {
  const { getFilingMaterial, readMaterialSnapshot } = await import("../filing-material/index.ts");
  const material = await getFilingMaterial(env, ticker, accession);
  if (material?.status !== "ready") return null;
  const snapshot = await readMaterialSnapshot(env, material.ref);
  const body = primaryUrl ?? snapshot.filing.documentUrl;
  const documents: ArchivedDocument[] = [];
  for (const source of snapshot.documents.filter(source => source.contentType === "text/html")) {
    const raw = await env.SEC_FILINGS.get(source.rawKey);
    if (!raw) throw new Error(`MATERIAL_SOURCE_MISSING:${source.filename}`);
    documents.push({ url: source.url, filename: source.filename, role: source.url === body ? "primary" : "exhibit", type: source.type, html: canonicalSecHtml(await raw.text()) });
  }
  documents.sort((a, b) => Number(a.role === "exhibit") - Number(b.role === "exhibit") || a.url.localeCompare(b.url));
  return { ticker, accession, form: snapshot.filing.form, filedAt: snapshot.filing.filedAt, reportDate: snapshot.filing.reportDate, complete: true, documents };
}

export { readArchivedDocument };

/**
 * The only reader that downloads filing documents: paced EDGAR requests whose documents are archived for the company
 * under their content hash, and read back from the archive when already there. Every collector step, maintenance step
 * and archive task reads through one of these, so nothing a task reads is left out of the archive.
 */
export function archivingReader(env: ArchiveEnv, ticker: string, causeId: string | null = null, options: GatewayOptions & { announce?: boolean } = {}): SecReader {
  const { announce, ...gateway } = options;
  const reader = edgarDocumentReader(env.SEC_USER_AGENT, { delayMs: 1000, ...gateway });
  const archive = { DB: env.DB, SEC_FILINGS: env.SEC_FILINGS };
  reader.archive = (source, html, metadata) => archiveFilingDisclosures(archive, ticker, source, html, metadata, causeId, { announce: announce ?? true }).then(() => undefined);
  reader.archived = async url => {
    const digits = /\/data\/\d+\/(\d{18})\//.exec(url)?.[1];
    if (digits) {
      const { getFilingMaterial, readMaterialSnapshot } = await import("../filing-material/index.ts");
      const accession = `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}`;
      const state = await getFilingMaterial(env, ticker, accession);
      if (state?.status === "ready") {
        const snapshot = await readMaterialSnapshot(env, state.ref);
        const source = snapshot.documents.find(source => source.url === url);
        if (source) {
          const object = await env.SEC_FILINGS.get(source.rawKey);
          if (!object) throw new Error(`MATERIAL_SOURCE_MISSING:${source.filename}`);
          return object.text();
        }
      }
    }
    return readArchivedDocument(archive, ticker, url);
  };
  reader.material = async filing => {
    const { getFilingMaterial, requestFilingMaterial, readMaterialSnapshot } = await import("../filing-material/index.ts");
    const materialEnv = { ...env, DB: env.DB };
    const state = await getFilingMaterial(materialEnv, ticker, filing.accession);
    if (state?.status === "ready") return readMaterialSnapshot(materialEnv, state.ref);
    const discovered = (await new D1SecRepository(env.DB).getCache<import("../pipeline/discovery.ts").DiscoveryState>(`sec:discovery:v1:${ticker}`))?.payload;
    const known = discovered?.current?.find(item => item.accession === filing.accession);
    await requestFilingMaterial(materialEnv, {
      ticker, accession: filing.accession, cik: filing.cik ?? filing.url.match(/\/data\/(\d+)\//)?.[1]?.padStart(10, "0") ?? "",
      form: known?.form ?? filing.form, filedAt: known?.filingDate ?? filing.filedAt, reportDate: known?.reportDate ?? filing.reportDate ?? "", companyName: discovered?.name ?? ticker,
      primaryDocument: fileOf(filing.url), documentUrl: filing.url,
      indexUrl: `${filing.url.slice(0, filing.url.lastIndexOf("/") + 1)}${filing.accession}-index.htm`,
    });
    throw new Error("FILING_MATERIAL_PENDING");
  };
  return withFilingStructure(reader, env.DB);
}

/** Stores a filing's documents the reader downloaded, as the collector does for the filings it parses. */
export async function archiveDocuments(reader: SecReader, source: Omit<DocumentSource, "url">, documents: Array<{ url: string; html: string }>, metadata: { form?: string; reportDate?: string }): Promise<void> {
  for (const document of documents) await reader.archive?.({ ...source, url: document.url }, document.html, metadata);
}
