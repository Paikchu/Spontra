import { AnalysisBackendClient } from "./analysis-client.ts";
import { asServiceBinding, serviceFetcher } from "../../../packages/web/src/model/service-binding.ts";

/**
 * Builds the Web Worker's client for the analysis backend. **Server-only** — it reads a runtime
 * secret, so importing it from a client component would put a read credential in a browser bundle.
 *
 * The credential is a real, server-held read credential, presented on every request. Being reached
 * over the Service Binding proves nothing on its own: the backend's fetch handler is publicly
 * reachable too, and a URL, a hostname, an `Origin`, or a header saying "internal" is not evidence
 * of anything. So Web authenticates exactly the way an unrelated service does.
 */
export type AnalysisBackendRuntime =
  | { configured: true; client: AnalysisBackendClient }
  | { configured: false; reason: "missing_token" | "missing_origin" };

export async function getAnalysisBackendRuntime(): Promise<AnalysisBackendRuntime> {
  const { env } = await import("cloudflare:workers");
  return createAnalysisBackendRuntime(env as unknown as Record<string, unknown>);
}

export function createAnalysisBackendRuntime(values: Record<string, unknown>): AnalysisBackendRuntime {
  const binding = asServiceBinding(values.EARNING_REPORT_PIPELINE);
  const token = stringValue(values.EARNING_REPORT_READ_TOKEN);
  const origin = binding ? "https://earning-report-pipeline.internal" : stringValue(values.EARNING_REPORT_PIPELINE_ORIGIN);
  if (!origin) return { configured: false, reason: "missing_origin" };
  if (!token) return { configured: false, reason: "missing_token" };
  return {
    configured: true,
    client: new AnalysisBackendClient({
      origin,
      token,
      // Over a Service Binding only the path is honoured, so the origin above is a formality there
      // and a real address when no binding is present.
      fetcher: serviceFetcher(binding),
    }),
  };
}

/** The public proxy's own limiter, keyed on the browser's IP rather than on Web's credential. */
export async function getPublicApiRateLimiter(): Promise<{ limit(options: { key: string }): Promise<{ success: boolean }> } | null> {
  const { env } = await import("cloudflare:workers");
  const binding = (env as unknown as Record<string, unknown>).EARNING_REPORT_API_RATE_LIMIT;
  return binding && typeof (binding as { limit?: unknown }).limit === "function"
    ? binding as { limit(options: { key: string }): Promise<{ success: boolean }> }
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
