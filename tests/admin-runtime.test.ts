import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("real Workers HTTP binding accepts login and forwards session and writes without following redirects", async () => {
  const bundle = await build({ entryPoints: ["apps/admin/worker/index.ts"], bundle: true, format: "esm", platform: "browser", write: false });
  const token = "report-admin.v1.123.abc.def";
  const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: "admin", modules: true, script: bundle.outputFiles[0].text, compatibilityDate: "2026-08-28", serviceBindings: { EARNING_REPORT_PIPELINE: "pipeline" } },
    { name: "pipeline", modules: true, compatibilityDate: "2026-08-28", script: `export default { async fetch(request) {
      if (new URL(request.url).pathname === '/admin/session') {
        if (request.headers.get('x-report-admin-password') === 'redirect') return Response.redirect('https://example.com', 302);
        if (request.headers.get('x-report-admin-password') !== 'test-password') return new Response('', {status:401});
        return Response.json({token:${JSON.stringify(token)}});
      }
      return Response.json({ method:request.method, authorization:request.headers.get('authorization'), body:await request.text() });
    } };` },
  ] }));
  const origin = "https://admin.test";
  try {
    const login = (key: string) => runtime.dispatchFetch(`${origin}/api/admin/session`, { method: "POST", headers: { origin }, body: JSON.stringify({ key }) });
    const signedIn = await login("test-password");
    assert.equal(signedIn.status, 200);
    assert.deepEqual(await signedIn.json(), { status: "signed_in" });
    assert.match(signedIn.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    const reviewed = await runtime.dispatchFetch(`${origin}/api/admin/reports/MSFT/filing/review`, { method: "POST", headers: { origin, cookie: `spontra_report_admin=${token}` }, body: '{"reviewed":true}' });
    assert.equal(reviewed.status, 200);
    assert.deepEqual(await reviewed.json(), { method: "POST", authorization: `Bearer ${token}`, body: '{"reviewed":true}' });
    assert.equal((await login("redirect")).status, 503);
  } finally { await runtime.dispose(); }
});
