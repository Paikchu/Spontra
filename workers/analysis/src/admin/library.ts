import { INDUSTRY_CATEGORIES, type IndustryCategory } from "../../../../shared/analysis-contract/business-classification.ts";
import type { MaterialState } from "../../../../shared/analysis-contract/filing-material.ts";
import type { PeerTier } from "../../../../shared/analysis-contract/business-tags.ts";
import { TIER_ORDER } from "../../../../shared/analysis-runtime/business-tags.ts";
import { TICKER_PATTERN } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { overrideLink, readLinksView, requestLinks } from "../business-classification/index.ts";
import { readSectorView, readTagCompanies, readTagsView, requestTags, setPairTier, setTagStatus } from "../business-tags/view.ts";
import { getFilingMaterial, listFilingMaterials, materialStateKey, readMaterialSnapshot } from "../filing-material/index.ts";
import { findFilingTables, readFilingMarkdown, readFilingTable } from "../filing-material/read.ts";
import type { AnalysisEnv } from "../operations.ts";
import { flushOutbox, outboxStatement } from "../pipeline/outbox.ts";
import { authenticateAdmin } from "./auth.ts";
import { json } from "./http.ts";

const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const SLUG = /^[\p{L}\p{N}-]{1,60}$/u;
const category = (value: string | null): IndustryCategory | undefined => value && Object.hasOwn(INDUSTRY_CATEGORIES, value) ? value as IndustryCategory : undefined;

export async function handleLibraryAdminRequest(request: Request, env: AnalysisEnv): Promise<Response> {
  if (!await authenticateAdmin(request, env.REPORT_ADMIN_PASSWORD)) return json({ error: "请登录财报管理后台。" }, 401);
  if (!env.DB) return json({ error: "数据服务暂时不可用。" }, 503);
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean).slice(2).map(decodeURIComponent);
  if (request.method === "GET" && !parts.length) {
    const prefix = "filing-material:state:v1:";
    const rows = await env.DB.prepare("SELECT payload FROM sec_cache WHERE cache_key >= ? AND cache_key < ? ORDER BY fetched_at DESC")
      .bind(prefix, `${prefix}\uffff`).all<{ payload: string }>();
    const materials: MaterialState[] = rows.results.map(row => JSON.parse(row.payload));
    return json({ materials });
  }
  if (request.method === "GET" && parts[0] === "companies" && parts.length === 2 && TICKER_PATTERN.test(parts[1]!)) {
    return json({ materials: await listFilingMaterials(env, parts[1]!) });
  }
  if (parts[0] === "materials" && TICKER_PATTERN.test(parts[1] ?? "") && ACCESSION.test(parts[2] ?? "")) {
    const ticker = parts[1]!, accession = parts[2]!;
    const state = await getFilingMaterial(env, ticker, accession);
    if (!state) return json({ error: "未找到该申报材料。" }, 404);
    if (request.method === "POST" && parts.length === 4 && parts[3] === "prepare") {
      const pending: MaterialState = { status: "preparing", filing: state.filing, progress: "awaiting accession archive" };
      await env.DB.batch([
        env.DB.prepare("UPDATE sec_cache SET payload = ?, fetched_at = ? WHERE cache_key = ?")
          .bind(JSON.stringify(pending), new Date().toISOString(), materialStateKey(ticker, accession)),
        outboxStatement(env.DB, { type: "filing.material.requested", ticker, cik: state.filing.cik, detail: { accession, form: state.filing.form } }),
      ]);
      await flushOutbox(env);
      return json(pending, 202);
    }
    if (request.method === "GET") {
      if (parts.length === 3) return json(state);
      if (state.status !== "ready") return json(state, 409);
      const snapshot = await readMaterialSnapshot(env, { ...state.ref, version: url.searchParams.get("version") ?? state.ref.version });
      if (parts.length === 4 && parts[3] === "index") return json(snapshot);
      if (parts.length === 4 && parts[3] === "markdown") return json(await readFilingMarkdown(env, snapshot, {
        anchor: url.searchParams.get("anchor") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined,
      }));
      if (parts.length === 4 && parts[3] === "tables") return json(findFilingTables(snapshot, {
        name: url.searchParams.get("name") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined,
      }));
      if (parts.length === 5 && parts[3] === "tables") return json(readFilingTable(snapshot, parts[4]!, {
        cursor: url.searchParams.get("cursor") ?? undefined,
      }));
    }
  }
  if (parts[0] === "links") {
    if (request.method === "GET" && parts.length <= 2 && (parts.length === 1 || TICKER_PATTERN.test(parts[1]!))) return json(await readLinksView(env, parts[1]));
    if (request.method === "POST" && parts.length === 3 && TICKER_PATTERN.test(parts[1]!) && parts[2] === "run") {
      await requestLinks(env, parts[1]!);
      return json({ status: "requested" }, 202);
    }
    if (request.method === "POST" && parts.length === 3 && TICKER_PATTERN.test(parts[1]!) && SLUG.test(parts[2]!)) {
      const body = await request.json() as { automatic?: boolean; industryCategory?: string | null };
      const changed = await overrideLink(env.DB, parts[1]!, `${parts[1]}:${parts[2]}`, body.automatic === true ? { automatic: true } : { industryCategory: body.industryCategory ?? null });
      if (changed) await requestTags(env, parts[1]!);
      return changed ? json({ status: "saved" }) : json({ error: "未找到该业务。" }, 404);
    }
  }
  if (parts[0] === "tags") {
    if (request.method === "GET" && parts.length === 1) return json(await readTagCompanies(env.DB));
    if (request.method === "GET" && parts.length === 3 && parts[1] === "sectors") {
      const sector = category(parts[2]!);
      return sector ? json(await readSectorView(env.DB, sector)) : json({ error: "未知的行业类别。" }, 404);
    }
    if (request.method === "GET" && parts.length === 2 && TICKER_PATTERN.test(parts[1]!)) return json(await readTagsView(env, parts[1]!));
    if (request.method === "POST" && parts.length === 3 && TICKER_PATTERN.test(parts[1]!) && parts[2] === "run") {
      await requestTags(env, parts[1]!);
      return json({ status: "requested" }, 202);
    }
    if (request.method === "POST" && parts.length === 4 && TICKER_PATTERN.test(parts[1]!) && parts[2] === "tag" && /^t[a-f0-9]{24}$/.test(parts[3]!)) {
      const body = await request.json() as { status: "verified" | "rejected" };
      return await setTagStatus(env, parts[1]!, parts[3]!, body.status) ? json({ status: "saved" }) : json({ error: "未找到该标签。" }, 404);
    }
    if (request.method === "POST" && parts.length === 3 && TICKER_PATTERN.test(parts[1]!) && parts[2] === "pair") {
      const body = await request.json() as { pairKey: string; tier: PeerTier; automatic?: boolean };
      if (body.automatic !== true && !(TIER_ORDER as readonly unknown[]).includes(body.tier)) return json({ error: "未知的档位。" }, 400);
      const saved = await setPairTier(env, parts[1]!, body.pairKey, body.automatic === true ? { automatic: true } : { tier: body.tier });
      return saved ? json({ status: "saved" }) : json({ error: "未找到该配对。" }, 404);
    }
  }
  return json({ error: "Not found" }, 404);
}
