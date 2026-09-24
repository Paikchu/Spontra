import { asServiceBinding, serviceFetcher } from "./earning-report/web/service-binding.ts";

/** Personal research uses its own server-side credential, separate from public financial reads. */
export async function researchBackend(path: string, init: RequestInit = {}): Promise<Response> {
  const { env } = await import("cloudflare:workers");
  const values = env as unknown as Record<string, unknown>;
  const binding = asServiceBinding(values.EARNING_REPORT_PIPELINE);
  const key = values.RESEARCH_SYNC_KEY;
  if (!binding || typeof key !== "string" || !key) return Response.json({ error: "Research is not configured" }, { status: 503 });
  return serviceFetcher(binding)(`https://earning-report-pipeline.internal${path}`, {
    ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000),
  });
}
