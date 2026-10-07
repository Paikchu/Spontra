import assert from "node:assert/strict";
import test from "node:test";

import { findIrDeck, AlphaVantageTranscriptProvider, readSecExhibits, reportedTranscriptRef, TranscriptAccessError, TranscriptQuotaError } from "../../workers/pipeline/src/guidance/sources.ts";

const KEY = "test-alpha-key-should-never-leak";
const ref = { fiscalYear: 2027, quarter: 1 as const, date: "2026-09-09" };
const transcript = [
  { speaker: "Operator", title: "", content: "Welcome to Oracle first quarter fiscal 2027 earnings call." },
  { speaker: "CEO", title: "Chief Executive Officer", content: "We expect total revenues to grow 12% to 14%. ".repeat(60) },
  { speaker: "Analyst", title: "", content: "What is driving demand?" },
  { speaker: "CEO", title: "", content: "Cloud demand remains strong." },
];
function alpha(response: () => Response) {
  const urls: string[] = [];
  const fetcher = (async (input: URL | string) => { urls.push(String(input)); return response(); }) as typeof fetch;
  return { urls, provider: new AlphaVantageTranscriptProvider(KEY, fetcher) };
}

test("Alpha Vantage requests the fiscal quarter and preserves all speaker turns without exposing the key", async () => {
  const { urls, provider } = alpha(() => Response.json({ symbol: "ORCL", quarter: "2027Q1", transcript }));
  const material = await provider.fetch("ORCL", ref);
  assert.ok(material && "text" in material);
  assert.ok(material.text.startsWith("Operator: Welcome"));
  assert.ok(material.text.includes("CEO — Chief Executive Officer:"));
  assert.ok(material.text.endsWith("CEO: Cloud demand remains strong."));
  const request = new URL(urls[0]);
  assert.equal(request.searchParams.get("quarter"), "2027Q1", "Oracle fiscal year differs from the release calendar year");
  assert.equal(request.searchParams.get("function"), "EARNINGS_CALL_TRANSCRIPT");
  assert.equal(request.searchParams.get("apikey"), KEY);
  assert.equal(request.hostname, "www.alphavantage.co");
  assert.ok(!JSON.stringify(material).includes(KEY) && !material.url.includes("apikey"));
});

test("Alpha Vantage distinguishes quota exhaustion, access refusal, outages and unavailable transcripts", async () => {
  const quota = alpha(() => Response.json({ Information: `API key ${KEY} has reached the 25 requests per day limit.` }));
  await assert.rejects(quota.provider.fetch("ORCL", ref), (e: Error) => e instanceof TranscriptQuotaError && !e.message.includes(KEY));
  const volume = alpha(() => Response.json({ Information: 'Thank you for using Alpha Vantage! Please contact premium@alphavantage.co if you are targeting a higher API call volume.' }));
  await assert.rejects(volume.provider.fetch("ORCL", ref), TranscriptQuotaError);
  const denied = alpha(() => Response.json({ Information: `Invalid API key ${KEY}` }));
  await assert.rejects(denied.provider.fetch("ORCL", ref), (e: Error) => e instanceof TranscriptAccessError && !e.message.includes(KEY));
  const down = alpha(() => new Response("busy", { status: 503 }));
  await assert.rejects(down.provider.fetch("ORCL", ref), (e: Error) => !(e instanceof TranscriptAccessError));
  const empty = alpha(() => Response.json({ symbol: "ORCL", quarter: "2027Q1", transcript: [] }));
  assert.equal(await empty.provider.fetch("ORCL", ref), null);
  const mismatch = alpha(() => Response.json({ symbol: "ORCL", quarter: "2026Q1", transcript }));
  await assert.rejects(mismatch.provider.fetch("ORCL", ref), /mismatch/);
  const network = new AlphaVantageTranscriptProvider(KEY, (async () => { throw new Error(`Failed URL ?apikey=${KEY}`); }) as typeof fetch);
  await assert.rejects(network.fetch("ORCL", ref), (e: Error) => !e.message.includes(KEY));
});

test("reported quarter comes from actual results headlines, never the forward outlook", () => {
  const release = (title: string) => [{ kind: "press_release" as const, sourceKind: "sec" as const, title, url: "https://www.sec.gov/release", publishedAt: ref.date,
    text: `${title}\nOutlook: For the second quarter of fiscal 2027, we expect growth.` }];
  for (const title of ["Oracle Announces Fiscal 2027 First Quarter Financial Results", "First Quarter Fiscal Year 2027 Results", "Q1 FY2027 Results", "FY2027 Q1 Results"]) {
    assert.deepEqual(reportedTranscriptRef(release(title), ref.date), ref);
  }
  assert.equal(reportedTranscriptRef(release("Oracle Financial Results"), ref.date), null);
  assert.deepEqual(reportedTranscriptRef(release("Oracle Announces Fiscal 2026 Fourth Quarter and Fiscal Full Year Financial Results"), ref.date), { ...ref, fiscalYear: 2026, quarter: 4 });
});

test("SEC: Exhibit 99 text documents are read and classified; binary exhibits are reported, not parsed", async () => {
  const release = `<html><body><p>Oracle Announces Fiscal 2027 First Quarter Financial Results</p><p>${"Total revenues were up 12%. ".repeat(30)}</p><p>Outlook: we expect growth of 12% to 14%.</p></body></html>`;
  const submission = [
    "<SEC-HEADER>header</SEC-HEADER>",
    "<DOCUMENT>\n<TYPE>8-K\n<FILENAME>orcl-8k.htm\n<TEXT>\n<html>Item 2.02</html>\n</TEXT>\n</DOCUMENT>",
    `<DOCUMENT>\n<TYPE>EX-99.1\n<FILENAME>orcl-ex99_1.htm\n<TEXT>\n${release}\n</TEXT>\n</DOCUMENT>`,
    "<DOCUMENT>\n<TYPE>EX-99.2\n<FILENAME>orcl-deck.pdf\n<TEXT>\nbegin 644 orcl-deck.pdf\nM)5!$1BTQ+C0*\nend\n</TEXT>\n</DOCUMENT>",
    "<DOCUMENT>\n<TYPE>GRAPHIC\n<FILENAME>logo.jpg\n<TEXT>\nbegin 644 logo.jpg\n</TEXT>\n</DOCUMENT>",
  ].join("\n");
  const requested: string[] = [];
  const fetcher = (async (input: string) => { requested.push(String(input)); return new Response(submission); }) as unknown as typeof fetch;
  const found = await readSecExhibits({ cikNumber: 1341439, accessionNumber: "0001341439-26-000020", filingDate: "2026-09-09" }, fetcher, "test agent");
  assert.deepEqual(requested, ["https://www.sec.gov/Archives/edgar/data/1341439/000134143926000020/0001341439-26-000020.txt"]);
  assert.equal(found.length, 2);
  const [text, pdf] = found;
  assert.equal(text!.kind, "press_release");
  assert.ok("text" in text! && text.text.includes("we expect growth of 12% to 14%") && !text.text.includes("<p>"));
  assert.equal(text!.title, "Oracle Announces Fiscal 2027 First Quarter Financial Results");
  assert.ok("unsupported" in pdf! && pdf.url.endsWith("/orcl-deck.pdf"));
});

test("IR deck fallback reads only a company-hosted deck that names the same quarter", async () => {
  const wrap = <T>(data: T) => ({ data, provider: "fake", fetchedAt: "", expiresAt: "", cache: "miss" as const, cacheKey: "k" });
  const reads: string[] = [];
  const search = (deckText: string) => ({
    async search() { return wrap({ kind: "search" as const, results: [
      { title: "Autodesk Q3 FY26 slides (mirror)", url: "https://www.slideshare.net/adsk.pdf", snippet: "", publishedAt: null, score: 1 },
      { title: "Q3 FY26 Earnings Presentation", url: "https://investors.autodesk.com/static-files/q3fy26.pdf", snippet: "", publishedAt: null, score: 0.9 },
    ] }); },
    async fetchContent(request: { url: string }, policy: { maxAgeMs?: number }) { assert.ok(policy.maxAgeMs! <= 30 * 86_400_000); reads.push(request.url); return wrap({ kind: "content" as const, url: request.url, text: deckText, format: "markdown" as const, completeness: "unverified" as const }); },
  });
  const input = { ticker: "ADSK", companyName: "Autodesk, Inc.", ref: { fiscalYear: 2026, quarter: 3 as const, date: "2025-11-25" }, hosts: [] };
  const deck = await findIrDeck(search(`Q3 FY26 Earnings Presentation\n${"Outlook Q4 FY26 revenue $1.90B-$1.92B ".repeat(20)}`), input);
  assert.equal(deck?.host, "investors.autodesk.com");
  assert.equal(deck?.material.kind, "deck");
  assert.deepEqual(reads, ["https://investors.autodesk.com/static-files/q3fy26.pdf"], "the third-party mirror is never read");
  assert.equal(await findIrDeck(search(`Investor Day 2025\n${"Long-term model ".repeat(40)}`), input), null, "another quarter's or event's deck is rejected");
});
