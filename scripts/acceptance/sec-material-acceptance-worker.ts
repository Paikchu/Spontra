import type { AnalysisEnv } from "../../src/operations.ts";
import { handleMaterialAcceptance } from "../../src/api/admin/material-acceptance.ts";
import { readPreview } from "../../src/domains/publishing/artifact/store.ts";
import { handleMapRead } from "../../src/api/public/router.ts";
import type { PublishedArtifact } from "../../src/domains/publishing/artifact-contract.ts";

export { TaskRunner } from "../../src/ai/durable-runs/runner.ts";

type Env = AnalysisEnv & { ASSETS?: Fetcher; SEC_ACCEPTANCE_KEY?: string };

const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

function previewShell(artifact: PublishedArtifact): Response {
  const source = scriptJson({ type: "artifact:render", html: artifact.html, css: artifact.css, lang: artifact.lang, hostTitle: artifact.title });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SEC report acceptance</title><style>body{margin:0;padding:24px;background:#fff}iframe{width:100%;border:0;display:block}@media(prefers-color-scheme:dark){body{background:#121212}}</style></head><body><section class="lens"><iframe sandbox="allow-scripts" data-artifact-frame data-artifact-hash="${artifact.hash}" src="/artifact-frame"></iframe></section><script>const frame=document.querySelector('iframe');const payload=${source};window.addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;if(e.data.type==='artifact:ready')frame.contentWindow.postMessage({...payload,dark:matchMedia('(prefers-color-scheme:dark)').matches},'*');if(e.data.type==='artifact:size'||e.data.type==='artifact:rendered'){frame.style.height=e.data.height+'px';if(e.data.type==='artifact:rendered')frame.setAttribute('data-rendered','true')}});frame.addEventListener('load',()=>frame.contentWindow.postMessage({type:'artifact:ping'},'*'));</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/artifact-frame") return env.ASSETS?.fetch(new Request(new URL("/artifact-frame", url), request)) ?? new Response("Assets are not mounted", { status: 404 });
    if (url.pathname.startsWith("/companies/") || url.pathname === "/article-preview") {
      const token = url.searchParams.get("artifact-preview") ?? url.searchParams.get("token");
      const artifact = token ? await readPreview(env, token) : null;
      return artifact ? previewShell(artifact) : new Response("No valid artifact preview", { status: 404 });
    }
    if (url.pathname.startsWith("/api/v1/")) return handleMapRead(request, env);
    if (!url.pathname.startsWith("/acceptance/")) return env.ASSETS?.fetch(request) ?? new Response("Not found", { status: 404 });
    const key = request.headers.get("x-acceptance-key");
    if (env.SEC_ACCEPTANCE_KEY ? key !== env.SEC_ACCEPTANCE_KEY : !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return new Response("Not found", { status: 404 });
    return handleMaterialAcceptance(request, { ...env, ACCEPTANCE_STORAGE_MODE: "isolated" });
  },
};
