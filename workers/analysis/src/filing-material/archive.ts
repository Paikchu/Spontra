import { unzipSync } from "fflate";
import { z } from "zod";
import { MATERIAL_ARCHIVE_INVENTORY_VERSION, type MaterialArchiveInventory, type MaterialFiling, type MaterialSource } from "../../../../shared/analysis-contract/filing-material.ts";
import { decodeEntities } from "../../../../shared/analysis-runtime/financial-data/disclosure-extraction.ts";
import { parseSecArchiveDocumentUrl } from "../../../../shared/analysis-runtime/sec-sources.ts";
import type { AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { materialEdgarReader, type GatewayOptions } from "../sec-archive/index.ts";
import { MATERIAL_PREFIX, materialDigest } from "./store.ts";

export type ManifestEntry = { filename: string; type: string; url: string; start: number | null; end: number | null; container: string | null };
export type MaterialManifest = { filing: MaterialFiling; entries: ManifestEntry[]; submission: MaterialSource; headerEnd: number; inventory: MaterialArchiveInventory };

const directorySchema = z.object({ directory: z.object({ item: z.array(z.object({ name: z.string().min(1) })) }) });

const receiptKey = (filing: MaterialFiling, id: string) => `filing-material:source:v1:${filing.ticker}:${filing.accession}:${id}`;
const manifestKey = (filing: MaterialFiling) => `${MATERIAL_PREFIX}${filing.ticker}/${filing.accession}/manifest.json`;
const filingRoot = (filing: MaterialFiling) => `${parseSecArchiveDocumentUrl(filing.documentUrl).archiveRoot}/`;
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const ascii = (bytes: Uint8Array) => {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32_768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32_768)));
  return chunks.join("");
};

export const sourceMimeType = (filename: string): string => {
  const ext = filename.split(".").at(-1)?.toLowerCase() ?? "";
  return ({ htm: "text/html", html: "text/html", txt: "text/plain", xml: "application/xml", xsd: "application/xml", json: "application/json", zip: "application/zip",
    pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp",
    csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }[ext]) ?? "application/octet-stream";
};

function submissionEntries(bytes: Uint8Array, root: string): { entries: ManifestEntry[]; headerEnd: number } {
  const text = ascii(bytes), entries: ManifestEntry[] = [];
  const documents = /<DOCUMENT>/gi;
  let match: RegExpExecArray | null;
  while ((match = documents.exec(text))) {
    const end = text.indexOf("</DOCUMENT>", match.index);
    if (end < 0) throw new Error("SUBMISSION_DOCUMENT_NOT_CLOSED");
    const opening = /<TEXT>\r?\n?/i.exec(text.slice(match.index, end));
    const headerEnd = opening ? match.index + opening.index : end;
    const header = text.slice(match.index, headerEnd);
    const filename = /<FILENAME>([^\r\n]+)/i.exec(header)?.[1]?.trim();
    const type = /<TYPE>([^\r\n]+)/i.exec(header)?.[1]?.trim() ?? "DOCUMENT";
    if (!filename || !opening) throw new Error("SUBMISSION_DOCUMENT_HEADER_INCOMPLETE");
    const start = match.index + opening.index + opening[0].length;
    const close = text.lastIndexOf("</TEXT>", end);
    if (close < start) throw new Error(`SUBMISSION_DOCUMENT_BODY_MISSING:${filename}`);
    let contentEnd = close;
    if (bytes[contentEnd - 1] === 10) contentEnd--;
    if (bytes[contentEnd - 1] === 13) contentEnd--;
    entries.push({ filename, type, url: new URL(filename, root).href, start, end: contentEnd, container: null });
    documents.lastIndex = end + "</DOCUMENT>".length;
  }
  if (!entries.length) throw new Error("SUBMISSION_HAS_NO_DOCUMENTS");
  return { entries, headerEnd: text.search(/<DOCUMENT>/i) };
}

function indexEntries(html: string, root: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(cell => cell[1]!);
    if (cells.length < 4) continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(cells[2]!)?.[1];
    if (!href) continue;
    const link = new URL(decodeEntities(href), root);
    const document = link.searchParams.get("doc");
    const url = document ? new URL(document, root) : link;
    if (!url.href.startsWith(root)) continue;
    const filename = decodeURIComponent(url.pathname.slice(new URL(root).pathname.length));
    if (!filename || /-index\.html?$/.test(filename)) continue;
    entries.push({ filename, url: url.href, type: decodeEntities(cells[3]!.replace(/<[^>]*>/g, " ")).trim() || "DOCUMENT", start: null, end: null, container: null });
  }
  return entries;
}

function decodeUuencoded(bytes: Uint8Array): Uint8Array {
  const text = decode(bytes);
  const opening = /^begin [0-7]{3} .+\r?$/m.exec(text);
  if (!opening) return bytes;
  const out: number[] = [];
  for (const line of text.slice(opening.index + opening[0].length).split(/\r?\n/)) {
    if (line === "end") break;
    if (!line.length) continue;
    const length = (line.charCodeAt(0) - 32) & 63;
    let produced = 0;
    for (let i = 1; produced < length; i += 4) {
      const a = ((line.charCodeAt(i) - 32) & 63), b = ((line.charCodeAt(i + 1) - 32) & 63);
      const c = ((line.charCodeAt(i + 2) - 32) & 63), d = ((line.charCodeAt(i + 3) - 32) & 63);
      for (const value of [(a << 2) | (b >> 4), ((b << 4) | (c >> 2)) & 255, ((c << 6) | d) & 255]) {
        if (produced++ < length) out.push(value);
      }
    }
  }
  return new Uint8Array(out);
}

async function putSource(env: AnalysisEnv, filing: MaterialFiling, entry: ManifestEntry, bytes: Uint8Array, contentType = sourceMimeType(entry.filename)): Promise<MaterialSource> {
  const sha256 = await materialDigest(bytes), id = `d${(await materialDigest(entry.url)).slice(0, 24)}`;
  const existing = (await new D1SecRepository(env.DB!).getCache<MaterialSource>(receiptKey(filing, id)))?.payload;
  if (existing?.sha256 === sha256 && await env.SEC_FILINGS.get(existing.rawKey)) return existing;
  const rawKey = `${MATERIAL_PREFIX}sources/${sha256}`;
  await env.SEC_FILINGS.put(rawKey, bytes, { httpMetadata: { contentType } });
  const source: MaterialSource = { id, filename: entry.filename, type: entry.type, url: entry.url, contentType, rawKey, sha256, bytes: bytes.byteLength, container: entry.container };
  await new D1SecRepository(env.DB!).setCache(receiptKey(filing, id), source, new Date().toISOString());
  return source;
}

export async function readSourceBytes(env: Pick<AnalysisEnv, "SEC_FILINGS">, source: MaterialSource): Promise<Uint8Array> {
  const object = await env.SEC_FILINGS.get(source.rawKey);
  if (!object) throw new Error(`MATERIAL_SOURCE_MISSING:${source.filename}`);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (await materialDigest(bytes) !== source.sha256) throw new Error(`MATERIAL_SOURCE_HASH_MISMATCH:${source.filename}`);
  return bytes;
}

export async function loadMaterialManifest(env: AnalysisEnv, filing: MaterialFiling, options: GatewayOptions = {}): Promise<MaterialManifest> {
  const key = manifestKey(filing), stored = await env.SEC_FILINGS.get(key);
  if (stored) {
    const manifest: MaterialManifest = JSON.parse(await stored.text());
    if (manifest.inventory?.inventoryVersion === MATERIAL_ARCHIVE_INVENTORY_VERSION) return manifest;
  }
  const reader = materialEdgarReader(env.SEC_USER_AGENT, { delayMs: 250, ...options });
  const index = await reader.index(filing.cik, filing.accession), directoryText = await reader.directory(filing.cik, filing.accession);
  const directory = directorySchema.parse(JSON.parse(directoryText));
  const bytes = await reader.submission(filing.cik, filing.accession);
  const root = filingRoot(filing);
  const submissionName = `${filing.accession}.txt`;
  const submission = await putSource(env, filing, { filename: submissionName, type: "SUBMISSION", url: `${root}${submissionName}`, start: null, end: null, container: null }, bytes, "text/plain");
  const parsed = submissionEntries(bytes, root);
  const union = new Map(parsed.entries.map(entry => [entry.filename, entry]));
  for (const entry of indexEntries(index, root)) if (entry.filename !== submissionName && !union.has(entry.filename)) union.set(entry.filename, entry);
  const excluded: MaterialArchiveInventory["excluded"] = [];
  for (const { name: filename } of directory.directory.item) {
    if (filename === submissionName) { excluded.push({ filename, reason: "archived-as-complete-submission" }); continue; }
    if (filename === `${filing.accession}-index.htm` || filename === `${filing.accession}-index.html`) {
      excluded.push({ filename, reason: "sec-generated-filing-index" }); continue;
    }
    if (filename === `${filing.accession}-index-headers.htm` || filename === `${filing.accession}-index-headers.html`) {
      excluded.push({ filename, reason: "sec-generated-filing-header-index" }); continue;
    }
    if (!union.has(filename)) union.set(filename, { filename, type: "SEC-DIRECTORY", url: new URL(filename, root).href, start: null, end: null, container: null });
  }
  if (!union.has(filing.primaryDocument)) union.set(filing.primaryDocument, { filename: filing.primaryDocument, type: filing.form, url: filing.documentUrl, start: null, end: null, container: null });
  const sha256 = await materialDigest(directoryText), rawKey = `${MATERIAL_PREFIX}sources/${sha256}`;
  await env.SEC_FILINGS.put(rawKey, directoryText, { httpMetadata: { contentType: "application/json" }, onlyIf: { etagDoesNotMatch: "*" } });
  const inventory: MaterialArchiveInventory = { inventoryVersion: MATERIAL_ARCHIVE_INVENTORY_VERSION,
    directory: { url: `${root}index.json`, rawKey, sha256, files: directory.directory.item.map(item => item.name) }, excluded };
  const manifest: MaterialManifest = { filing, entries: [...union.values()], submission, headerEnd: parsed.headerEnd, inventory };
  await env.SEC_FILINGS.put(key, JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });
  await env.SEC_FILINGS.put(`${key.slice(0, -5)}-index.html`, index, { httpMetadata: { contentType: "text/html" } });
  return manifest;
}

export async function archiveMaterialEntry(env: AnalysisEnv, manifest: MaterialManifest, entry: ManifestEntry, submissionBytes: Uint8Array, options: GatewayOptions = {}): Promise<MaterialSource> {
  const id = `d${(await materialDigest(entry.url)).slice(0, 24)}`;
  const cached = (await new D1SecRepository(env.DB!).getCache<MaterialSource>(receiptKey(manifest.filing, id)))?.payload;
  if (cached && await env.SEC_FILINGS.get(cached.rawKey)) return cached;
  if (entry.start !== null && entry.end !== null) return putSource(env, manifest.filing, entry, decodeUuencoded(submissionBytes.subarray(entry.start, entry.end)));
  const response = await materialEdgarReader(env.SEC_USER_AGENT, options).document(entry.url);
  return putSource(env, manifest.filing, entry, new Uint8Array(await response.arrayBuffer()), response.headers.get("content-type")?.split(";")[0] || sourceMimeType(entry.filename));
}

export async function archiveZipEntries(env: AnalysisEnv, filing: MaterialFiling, source: MaterialSource, bytes: Uint8Array): Promise<MaterialSource[]> {
  const entries = unzipSync(bytes), sources: MaterialSource[] = [];
  for (const [filename, content] of Object.entries(entries)) {
    if (filename.endsWith("/")) continue;
    const type = sourceMimeType(filename);
    const child = await putSource(env, filing, { filename, type: type === "application/xml" ? "XML" : "ZIP-ENTRY", url: `${source.url}#zip/${encodeURIComponent(filename)}`, start: null, end: null, container: source.id }, content);
    sources.push(child);
    if (type === "application/zip") sources.push(...await archiveZipEntries(env, filing, child, content));
  }
  return sources;
}

export function referencedMaterialEntries(manifest: MaterialManifest, source: MaterialSource, bytes: Uint8Array): ManifestEntry[] {
  if (!/html|xml/.test(source.contentType)) return [];
  const root = filingRoot(manifest.filing), existing = new Set(manifest.entries.map(entry => entry.url));
  return [...decode(bytes).matchAll(/\b(?:src|href)\s*=\s*["']([^"'#]+)["']/gi)].flatMap(match => {
    let url: URL;
    try { url = new URL(decodeEntities(match[1]!), source.url); } catch { return []; }
    if (!url.href.startsWith(root) || url.search || url.hash || existing.has(url.href) || !/\.(?:png|jpe?g|gif|svg|bmp|webp|pdf)$/i.test(url.pathname)) return [];
    existing.add(url.href);
    return [{ filename: decodeURIComponent(url.pathname.slice(new URL(root).pathname.length)), type: "REFERENCED-ASSET", url: url.href, start: null, end: null, container: null }];
  });
}

export async function saveMaterialManifest(env: Pick<AnalysisEnv, "SEC_FILINGS">, manifest: MaterialManifest): Promise<void> {
  await env.SEC_FILINGS.put(manifestKey(manifest.filing), JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });
}
