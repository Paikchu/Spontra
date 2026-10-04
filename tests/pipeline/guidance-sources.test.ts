import assert from "node:assert/strict";
import test from "node:test";

import { findIrDeck, FmpTranscriptProvider, readSecExhibits, TranscriptAccessError } from "../../workers/pipeline/src/guidance/sources.ts";

const KEY = "test-fmp-key-should-never-leak";

function fmp(routes: Record<string, () => Response>) {
  const urls: string[] = [];
  const fetcher = (async (input: URL | string) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const route = routes[url.pathname.split("/").at(-1)!];
    return route ? route() : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { urls, provider: new FmpTranscriptProvider(KEY, fetcher) };
}

test("FMP: the call nearest the release is matched by date, and the stored citation carries no key", async () => {
  const content = `Operator: Welcome.\n${"Safra Catz: We expect total revenues to grow 12% to 14%. ".repeat(60)}`;
  const { urls, provider } = fmp({
    "earning-call-transcript-dates": () => Response.json([
      { quarter: 4, fiscalYear: 2026, date: "2026-06-11" },
      { quarter: 1, fiscalYear: 2027, date: "2026-09-09" },
    ]),
    "earning-call-transcript": () => Response.json([{ symbol: "ORCL", period: "Q1", year: 2027, date: "2026-09-09", content }]),
  });
  const ref = await provider.find("ORCL", "2026-09-09");
  assert.deepEqual(ref, { fiscalYear: 2027, quarter: 1, date: "2026-09-09" });
  assert.equal(await provider.find("ORCL", "2026-12-15"), null, "a call not listed yet is not guessed");
  const material = await provider.fetch("ORCL", ref!);
  assert.equal(material?.kind, "transcript");
  assert.ok(material && "text" in material && material.text.length > 2000);
  assert.ok(!material!.url.includes(KEY) && !material!.url.includes("apikey"));
  assert.ok(urls.every(u => new URL(u).searchParams.get("apikey") === KEY), "the key is sent to FMP only");
  assert.equal(FmpTranscriptProvider.symbol("BRK.B"), "BRK-B");
});

test("FMP: plan or key problems are access errors without the key in the message", async () => {
  const denied = fmp({ "earning-call-transcript-dates": () => new Response("{}", { status: 402 }) });
  await assert.rejects(denied.provider.find("ORCL", "2026-09-09"), (error: Error) => error instanceof TranscriptAccessError && !error.message.includes(KEY));
  const refused = fmp({ "earning-call-transcript-dates": () => Response.json({ "Error Message": "Exclusive Endpoint" }) });
  await assert.rejects(refused.provider.find("ORCL", "2026-09-09"), TranscriptAccessError);
  const down = fmp({ "earning-call-transcript-dates": () => new Response("busy", { status: 503 }) });
  await assert.rejects(down.provider.find("ORCL", "2026-09-09"), (error: Error) => !(error instanceof TranscriptAccessError), "outages stay retryable");
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
    async fetchContent(request: { url: string }) { reads.push(request.url); return wrap({ kind: "content" as const, url: request.url, text: deckText, format: "markdown" as const, completeness: "unverified" as const }); },
  });
  const input = { ticker: "ADSK", companyName: "Autodesk, Inc.", ref: { fiscalYear: 2026, quarter: 3 as const, date: "2025-11-25" }, hosts: [] };
  const deck = await findIrDeck(search(`Q3 FY26 Earnings Presentation\n${"Outlook Q4 FY26 revenue $1.90B-$1.92B ".repeat(20)}`), input);
  assert.equal(deck?.host, "investors.autodesk.com");
  assert.equal(deck?.material.kind, "deck");
  assert.deepEqual(reads, ["https://investors.autodesk.com/static-files/q3fy26.pdf"], "the third-party mirror is never read");
  assert.equal(await findIrDeck(search(`Investor Day 2025\n${"Long-term model ".repeat(40)}`), input), null, "another quarter's or event's deck is rejected");
});
