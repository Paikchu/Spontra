import { test } from "node:test";
import assert from "node:assert/strict";
import { MAP_RESOURCES } from "../../../shared/analysis-contract/revisions.ts";
import { companyPath, createCompanyOpening } from "../src/company-opening.ts";
import { CompanyHttpError, fetchCompany, fetchValuation } from "../src/company-data.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("an opening starts once and launches all versioned resources before the route consumes them", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const revision = deferred<Response>();
  const requests: Array<{ url: string; signal: AbortSignal | null | undefined; cache: RequestCache | undefined }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, signal: init?.signal, cache: init?.cache });
    return url.endsWith("/revision") ? revision.promise : Response.json({ status: "ready" });
  };
  const opening = createCompanyOpening("META", "zh-CN");
  assert.equal(requests.length, 0, "pure handle creation does not fetch during render");
  const run = opening.start();
  assert.equal(opening.start(), run, "eager shell and lazy route share the same run");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].cache, "no-store");
  const versions = { company: "2026-10-30T00:00:00Z", capital: "2026-10-29T00:00:00Z" };
  revision.resolve(Response.json({ revisions: versions }));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests.length, 8, "resource downloads start even while no route consumer is mounted");
  assert.deepEqual(await run.revisions, versions);
  for (const resource of MAP_RESOURCES) {
    const suffix = resource === "company" ? "" : `/${resource}`;
    const request = requests.find(item => new URL(item.url, "https://example.test").pathname === `/api/business/v1/companies/META${suffix}`)!;
    const url = new URL(request.url, "https://example.test");
    assert.equal(url.searchParams.get("lang"), "zh-CN");
    assert.equal(url.searchParams.get("rev"), versions[resource as keyof typeof versions] ?? null);
    assert.equal(request.signal, run.signal);
    assert.equal((await run.response(resource)).status, 200);
  }
  run.abort();
});

test("leaving before the revision arrives prevents every resource request", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const revision = deferred<Response>();
  const requests: string[] = [];
  globalThis.fetch = async input => { requests.push(String(input)); return revision.promise; };
  const run = createCompanyOpening("META", "en").start();
  run.abort();
  // A mocked transport can finish after abort; the real fetch is also covered by its signal.
  revision.resolve(Response.json({ revisions: { company: "2026-10-30T00:00:00Z" } }));
  await assert.rejects(run.response("company"), error => error instanceof DOMException && error.name === "AbortError");
  assert.equal(requests.length, 1);
});

test("cleanup and retry get a new run without allowing an old cleanup to abort it", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const revisions = [deferred<Response>(), deferred<Response>()];
  let count = 0;
  globalThis.fetch = async input => String(input).endsWith("/revision") ? revisions[count++].promise : Response.json({ status: "ready" });
  const opening = createCompanyOpening("META", "en");
  const first = opening.start();
  first.abort();
  const second = opening.start();
  assert.notEqual(second, first);
  first.abort();
  assert.equal(second.signal.aborted, false, "StrictMode's old cleanup owns only its old run");
  revisions[0].resolve(Response.json({ revisions: {} }));
  revisions[1].resolve(Response.json({ revisions: {} }));
  await assert.rejects(first.response("company"));
  assert.equal((await second.response("company")).status, 200);
  assert.equal(count, 2);
  second.abort();
});

test("a resource failure before the module arrives remains available to its eventual consumer", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async input => {
    if (String(input).endsWith("/revision")) return Response.json({ revisions: {} });
    throw new Error("offline while loading company code");
  };
  const run = createCompanyOpening("META", "en").start();
  await new Promise<void>(resolve => setImmediate(resolve));
  await assert.rejects(run.response("company"), /offline while loading company code/);
  run.abort();
});

test("a failed revision read still starts the locale-specific unversioned reads", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const requests: string[] = [];
  globalThis.fetch = async input => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/revision")) throw new Error("revision unavailable");
    return Response.json({ status: "ready" });
  };
  const run = createCompanyOpening("BRK.B", "en").start();
  assert.equal(await run.revisions, null);
  await run.response("company");
  assert.equal(requests.length, 8);
  assert(requests.includes("/api/business/v1/companies/BRK.B"));
  assert(requests.every(url => !url.includes("lang=") && !url.includes("rev=")));
  run.abort();
});

test("the company readers consume the opening response without a second request", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => { throw new Error("unexpected duplicate fetch"); };
  const controller = new AbortController();
  await assert.rejects(fetchCompany("META", controller.signal, undefined, Promise.resolve(new Response(null, { status: 503 }))), error => error instanceof CompanyHttpError && error.status === 503);
  const body = { schemaVersion: "valuation-response.v1", availability: "hidden" };
  assert.deepEqual(await fetchValuation("META", controller.signal, undefined, Promise.resolve(Response.json(body))), body);
  assert.equal(companyPath("META", "zh-CN", "/valuation/versions/v1"), "/api/business/v1/companies/META/valuation/versions/v1?lang=zh-CN");
});
