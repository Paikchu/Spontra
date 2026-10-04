import test from "node:test";
import assert from "node:assert/strict";
import { SqliteD1Database } from "./helpers/sqlite-d1.ts";
import { archiveFilingDisclosures, getFilingDisclosureAuditPage, listFilingDisclosureAudits } from "../../workers/pipeline/src/financial-data/disclosure-audit.ts";

const source = { url: "https://www.sec.gov/Archives/edgar/data/1341439/000134143926000001/orcl.htm", accession: "0001341439-26-000001", cik: "0001341439", filedAt: "2026-09-10", industry: "standard" as const };
const html = `<html xmlns:ix="http://www.xbrl.org/2013/inlineXBRL" xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:us-gaap="http://fasb.org/us-gaap/2026" xmlns:iso4217="http://www.xbrl.org/2003/iso4217"><xbrli:context id="q"><xbrli:entity><xbrli:identifier scheme="http://www.sec.gov/CIK">0001341439</xbrli:identifier></xbrli:entity><xbrli:period><xbrli:startDate>2026-06-01</xbrli:startDate><xbrli:endDate>2026-08-31</xbrli:endDate></xbrli:period></xbrli:context><xbrli:unit id="usd"><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unit><ix:nonFraction name="us-gaap:Revenues" contextRef="q" unitRef="usd" decimals="0">100</ix:nonFraction><ix:nonFraction name="us-gaap:Assets" contextRef="q" unitRef="usd" decimals="0">500</ix:nonFraction><p>Unstructured note remains in source.</p></html>`;
function fixture() {
  const database = new SqliteD1Database();
  database.raw.exec("CREATE TABLE sec_cache(cache_key TEXT PRIMARY KEY,payload TEXT,fetched_at TEXT)");
  const objects = new Map<string,string>(); let failed = false;
  const bucket = { get: async (key: string) => objects.has(key) ? {text:async()=>objects.get(key)!} : null,
    put: async (key: string,value: string) => {if(failed)throw new Error("storage unavailable");objects.set(key,value);} };
  return { database, objects, env: {DB:database as unknown as D1Database,SEC_FILINGS:bucket}, fail:()=>{failed=true;} };
}
test("archive keeps exact source and all facts; repeat clicks are idempotent and details paginate without losing provenance", async()=>{
  const f=fixture();try{
    const audit=await archiveFilingDisclosures(f.env,"ORCL",source,html,{form:"10-Q",reportDate:"2026-08-31"});
    assert.equal(audit.factCount,2);assert.equal(audit.contentSha256.length,64);assert.equal(f.objects.size,2);assert.ok([...f.objects.values()].includes(html));
    assert.equal((await archiveFilingDisclosures(f.env,"ORCL",source,html)).archivedAt,audit.archivedAt);assert.equal(f.objects.size,2);
    assert.deepEqual(await listFilingDisclosureAudits(f.env.DB,"ORCL"),[audit]);
    const page=await getFilingDisclosureAuditPage(f.env,"ORCL",audit.documentId,{limit:1});
    assert.equal(page?.total,2);assert.equal(page?.nextOffset,1);assert.equal(page?.facts[0].numericValue,"100");assert.equal(page?.facts[0].source.documentUrl,source.url);
    const filtered=await getFilingDisclosureAuditPage(f.env,"ORCL",audit.documentId,{concept:"Assets",periodEnd:"2026-08-31"});assert.equal(filtered?.total,1);assert.equal(filtered?.facts[0].numericValue,"500");
    assert.equal(await getFilingDisclosureAuditPage(f.env,"MSFT",audit.documentId),null);
    assert.ok(!("inventoryKey" in page!.document));
  }finally{f.database.close();}
});
test("failed archive does not replace last-good pointer and a changed source retains recoverable prior objects",async()=>{
  const f=fixture();try{
    const first=await archiveFilingDisclosures(f.env,"ORCL",source,html);
    const second=await archiveFilingDisclosures(f.env,"ORCL",source,html.replace(">100<",">110<"));
    assert.notEqual(first.contentSha256,second.contentSha256);assert.equal(f.objects.size,4);
    f.fail();await assert.rejects(archiveFilingDisclosures(f.env,"ORCL",source,html.replace(">100<",">120<")));
    assert.equal((await listFilingDisclosureAudits(f.env.DB,"ORCL"))[0].contentSha256,second.contentSha256);
    await assert.rejects(archiveFilingDisclosures(f.env,"ORCL",{...source,url:"https://example.com/x"},html),/INVALID_DISCLOSURE_SOURCE/);
    await assert.rejects(getFilingDisclosureAuditPage(f.env,"ORCL",first.documentId,{limit:201}),/INVALID_AUDIT_QUERY/);
  }finally{f.database.close();}
});
