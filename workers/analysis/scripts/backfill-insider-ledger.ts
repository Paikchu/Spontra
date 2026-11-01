/**
 * Fills the insider ledger (`insider_transactions`, `insider_persons`; migration 0041) with a company's whole Form 4
 * history from EDGAR, so the by-person view reaches back before the event rail's window. Reads EDGAR's submission
 * list (every page) and each Form 4 document; applies B1, so a filing whose issuer is another company is left out.
 * No model calls. Every line is recorded as history (first seen on its filing date), so nothing old reads as new.
 *
 * Dry run by default: writes the SQL to a file and nothing to D1. `--apply` runs it through wrangler.
 *
 *   node --experimental-strip-types workers/analysis/scripts/backfill-insider-ledger.ts --tickers NVDA --user-agent "Spontra admin@example.com"
 *   node --experimental-strip-types workers/analysis/scripts/backfill-insider-ledger.ts --tickers NVDA,TSM --since 2021-01-01 --out /tmp/insiders.sql
 *   node --experimental-strip-types workers/analysis/scripts/backfill-insider-ledger.ts --tickers NVDA --apply            # remote D1
 *   node --experimental-strip-types workers/analysis/scripts/backfill-insider-ledger.ts --tickers NVDA --apply --local    # local D1
 *
 * Options: `--tickers A,B` (required); `--cik N` names the CIK for a single ticker instead of EDGAR's ticker list;
 * `--since YYYY-MM-DD` keeps filings from that date (default: everything); `--max N` caps the filings per company;
 * `--out file.sql` names the SQL file; `--user-agent` or SEC_USER_AGENT carries the contact EDGAR requires.
 * The same filing re-run rewrites the same rows (keyed by accession and line); the next event refresh recomputes
 * each person it touches from the table, so the person rows written here are the state at the time of the run.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizePerson } from "../../../shared/analysis-runtime/insiders.ts";
import { form4XmlUrl, normalizeCik, parseForm4 } from "../src/events/form4.ts";
import { PERSON_COLUMNS, PERSON_UPSERT, personRow, toLedgerRow, TRANSACTION_COLUMNS, TRANSACTION_UPSERT, transactionRows, type TransactionRow } from "../src/events/insider-ledger.ts";
import { secArchiveDocumentUrl, secArchiveRoot } from "../src/sec/archive-url.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] ?? null : null; };
const apply = args.includes("--apply");
const local = args.includes("--local");
const since = option("since") ?? "0000-00-00";
const max = Number(option("max") ?? Infinity);
const tickers = (option("tickers") ?? "").split(",").map(t => t.trim().toUpperCase()).filter(Boolean);
if (!tickers.length) throw new Error("Pass --tickers A,B");
const cikOption = option("cik");
if (cikOption && tickers.length !== 1) throw new Error("--cik names the CIK of one ticker");
// EDGAR refuses reads without a contact; use the one the worker is configured with (SEC_USER_AGENT in wrangler.jsonc).
const userAgent = option("user-agent") ?? process.env.SEC_USER_AGENT ?? null;
if (!userAgent) throw new Error("Pass --user-agent or set SEC_USER_AGENT: EDGAR needs a contact user-agent");

let last = 0;
/** EDGAR's fair-access pace (well under ten requests a second) with its required contact user-agent. */
async function sec(url: string): Promise<Response> {
  const wait = last + 150 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  last = Date.now();
  return fetch(url, { headers: { "user-agent": userAgent, accept: "application/xml,application/json,text/xml" } });
}

let edgarTickers: Record<string, { cik_str: number; ticker: string }> | null = null;
async function companyCik(ticker: string): Promise<string | null> {
  if (cikOption) return normalizeCik(cikOption);
  edgarTickers ??= await (await sec("https://www.sec.gov/files/company_tickers.json")).json() as Record<string, { cik_str: number; ticker: string }>;
  const dashed = ticker.replace(".", "-");
  const hit = Object.values(edgarTickers).find(c => c.ticker.toUpperCase() === ticker || c.ticker.toUpperCase() === dashed);
  return hit ? String(hit.cik_str) : null;
}

type Listed = { accessionNumber: string; form: "4" | "4/A"; filingDate: string; primaryDocument: string };
type SubmissionPage = { accessionNumber?: unknown[]; form?: unknown[]; filingDate?: unknown[]; primaryDocument?: unknown[] };
const listed = (page: SubmissionPage): Listed[] => (page.accessionNumber ?? []).flatMap((accession, i) => {
  const form = String(page.form?.[i] ?? ""), filingDate = String(page.filingDate?.[i] ?? "");
  return (form === "4" || form === "4/A") && /^\d{4}-\d{2}-\d{2}$/.test(filingDate) && filingDate >= since
    ? [{ accessionNumber: String(accession), form, filingDate, primaryDocument: String(page.primaryDocument?.[i] ?? "") }] : [];
});

/** Every Form 4 in the company's submission list: the recent page and each older one EDGAR splits off. */
async function form4Filings(cik: string): Promise<Listed[]> {
  const padded = cik.padStart(10, "0");
  const submissions = await (await sec(`https://data.sec.gov/submissions/CIK${padded}.json`)).json() as { filings?: { recent?: SubmissionPage; files?: Array<{ name: string }> } };
  const out = listed(submissions.filings?.recent ?? {});
  for (const file of submissions.filings?.files ?? []) out.push(...listed(await (await sec(`https://data.sec.gov/submissions/${file.name}`)).json() as SubmissionPage));
  return out.sort((a, b) => b.filingDate.localeCompare(a.filingDate) || b.accessionNumber.localeCompare(a.accessionNumber)).slice(0, max);
}

const quote = (value: unknown) => value == null ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replaceAll("'", "''")}'`;
/** The upsert with its placeholders filled, in the column order the statement names. */
const inline = (sql: string, values: unknown[]) => { let i = 0; return sql.replace(/\?/g, () => quote(values[i++])) + ";"; };

const now = new Date();
const stamp = now.toISOString();
const statements: string[] = [];
let lines = 0, filingsRecorded = 0, foreign = 0, unreadable = 0, people = 0;
for (const ticker of tickers) {
  const cik = await companyCik(ticker);
  if (!cik) { console.log(`${ticker}: no CIK, skipped`); continue; }
  const filings = await form4Filings(cik);
  console.log(`${ticker} (CIK ${cik}): ${filings.length} Form 4 filings listed`);
  const rows: TransactionRow[] = [];
  for (const filing of filings) {
    const root = secArchiveRoot(Number(cik), filing.accessionNumber);
    const response = await sec(form4XmlUrl(root, filing.primaryDocument));
    const parsed = response.ok ? parseForm4(await response.text()) : null;
    if (!parsed) { unreadable++; continue; }
    const event = { id: filing.accessionNumber, form: filing.form, filedAt: filing.filingDate, documentUrl: secArchiveDocumentUrl(root, filing.primaryDocument), edgarUrl: secArchiveDocumentUrl(root, `${filing.accessionNumber}-index.html`) };
    const recorded = transactionRows({ ticker, companyCik: cik, event, transaction: parsed, seenAt: `${filing.filingDate}T00:00:00.000Z` }, stamp, now);
    if (!recorded.length) { if (parsed.issuerCik && normalizeCik(parsed.issuerCik) !== cik) foreign++; continue; }
    filingsRecorded++;
    rows.push(...recorded);
  }
  for (const row of rows) statements.push(inline(TRANSACTION_UPSERT, TRANSACTION_COLUMNS.map(c => row[c])));
  const byPerson = new Map<string, TransactionRow[]>();
  for (const row of rows) byPerson.set(row.owner_key, [...(byPerson.get(row.owner_key) ?? []), row]);
  for (const [key, group] of byPerson) {
    const summary = summarizePerson(group.map(r => toLedgerRow(r, now)), now);
    if (!summary) continue;
    const person = personRow(ticker, cik, key, summary, stamp);
    statements.push(inline(PERSON_UPSERT, PERSON_COLUMNS.map(c => person[c])));
    people++;
  }
  lines += rows.length;
  console.log(`  ${filingsRecorded} filings recorded as ${rows.length} lines for ${byPerson.size} people; ${foreign} about another issuer, ${unreadable} unreadable`);
}

const file = option("out") ?? join(mkdtempSync(join(tmpdir(), "insider-ledger-")), "backfill.sql");
writeFileSync(file, statements.join("\n") + "\n");
console.log(`\n${lines} transaction rows and ${people} person rows across ${tickers.length} companies: ${statements.length} statements written to ${file}.`);
if (!apply) { console.log("Dry run: nothing written to D1. Re-run with --apply (and --local for the local database) to write."); process.exit(0); }
if (!statements.length) { console.log("Nothing to write."); process.exit(0); }
execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--config", "workers/analysis/wrangler.jsonc", "--env=", local ? "--local" : "--remote", "--file", file], { stdio: "inherit" });
console.log(`Applied ${statements.length} statements from ${file}.`);
