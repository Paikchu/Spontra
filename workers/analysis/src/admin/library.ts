import { reconcileImageSource, sourceReconciliationSchema } from "../filing-material/source-reconciliation.ts";
import { preparePilotMaterial } from "./material-pilot.ts";
import { INDUSTRY_CATEGORIES, type IndustryCategory } from "../../../../shared/analysis-contract/business-classification.ts";
import type { MaterialState } from "../../../../shared/analysis-contract/filing-material.ts";
import type { PeerTier } from "../../../../shared/analysis-contract/business-tags.ts";
import { TIER_ORDER } from "../../../../shared/analysis-runtime/business-tags.ts";
import { TICKER_PATTERN } from "../../../../shared/analysis-runtime/financial-data/policy.ts";
import { overrideLink, readLinksView, requestLinks } from "../business-classification/index.ts";
import { readSectorView, readTagCompanies, readTagsView, requestTags, setPairTier, setTagStatus } from "../business-tags/view.ts";
import { ASSEMBLE_STEP_FILENAME, leaseKey, listFilingMaterials, materialStateKey, readExtractionFiles, readFilingMaterialState, readMaterialBrief, readMaterialSnapshot, briefTableDescriptionMap, getMaterialBriefState, writeMaterialBriefState, requestFilingMaterial } from "../filing-material/index.ts";
import { filingMaterialMeta, findFilingTables, readFilingMarkdown, readFilingTable } from "../filing-material/read.ts";
import { aiToolEnvironment, modelFor } from "../ai-config.ts";
import { withRuns } from "../durable-runs/binding.ts";
import { createAnalysisOperations, type AnalysisEnv } from "../operations.ts";
import { D1SecRepository } from "../sec/d1.ts";
import type { SecFiling, SecFilingFeed } from "../sec/sec.ts";
import { selectLatestWorkflowFilings } from "../workflow-core.ts";
import { flushOutbox, outboxStatement } from "../pipeline/outbox.ts";
import { materialRecoveryKey, materialPilotKey, isPilotMaterial } from "../filing-material/store.ts";
import { authenticateAdmin } from "./auth.ts";
import { json } from "./http.ts";

const ACCESSION = /^\d{10}-\d{2}-\d{6}$/;
const SLUG = /^[\p{L}\p{N}-]{1,60}$/u;
const materialReviewKey = (ticker: string, accession: string) => `filing-material:review:v1:${ticker}:${accession}`;
type MaterialReview = { decision: "approved" | "rejected"; version: string | null; note?: string; reviewedAt: string };
const category = (value: string | null): IndustryCategory | undefined => value && Object.hasOwn(INDUSTRY_CATEGORIES, value) ? value as IndustryCategory : undefined;

function stripStateFiles(state: MaterialState): MaterialState {
  if (state.status === "ready" || !("files" in state) || !state.files) return state;
  const { files: _files, ...rest } = state;
  return rest as MaterialState;
}

async function attachMaterialReviews(db: D1Database, list: MaterialState[]): Promise<Array<MaterialState & { review: MaterialReview | null }>> {
  const prefix = "filing-material:review:v1:";
  const rows = await db.prepare("SELECT cache_key, payload FROM sec_cache WHERE cache_key >= ? AND cache_key < ?")
    .bind(prefix, `${prefix}\uffff`).all<{ cache_key: string; payload: string }>();
  const map = new Map<string, MaterialReview>();
  for (const r of rows.results) {
    try { map.set(r.cache_key, JSON.parse(r.payload) as MaterialReview); } catch { /* ignore */ }
  }
  return list.map(m => ({ ...stripStateFiles(m), review: map.get(materialReviewKey(m.filing.ticker, m.filing.accession)) ?? null }));
}

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
    return json({ materials: await attachMaterialReviews(env.DB, materials) });
  }
  if (request.method === "GET" && parts[0] === "companies" && parts.length === 2 && TICKER_PATTERN.test(parts[1]!)) {
    return json({ materials: await attachMaterialReviews(env.DB, await listFilingMaterials(env, parts[1]!)) });
  }
  if (request.method === "POST" && parts[0] === "companies" && parts.length === 3 && TICKER_PATTERN.test(parts[1]!) && parts[2] === "sync") {
    const ticker = parts[1]!;
    const cached = (await new D1SecRepository(env.DB).getCache<SecFilingFeed>(`sec:filings:${ticker}`))?.payload;
    let filings: SecFiling[] = cached?.filings ?? [];
    if (!filings.length) {
      const ops = createAnalysisOperations(env, fetch);
      const found = await ops.discover(ticker);
      await ops.publishFeed(found.feed);
      filings = found.filings;
    }
    const latest = selectLatestWorkflowFilings(filings);
    const selected = latest.length
      ? latest
      : filings.filter(f => /^(?:10-K|10-Q|20-F|40-F|8-K|6-K)(?:\/A)?$/.test(f.form)).slice(0, 4);
    for (const filing of selected) {
      await requestFilingMaterial(env, filingMaterialMeta(filing));
    }
    await flushOutbox(env);
    const prepareRunner = withRuns(env).MATERIAL_PREPARE_WORKFLOW;
    if (prepareRunner && selected.length) {
      await prepareRunner.create({
        id: `material-prepare-${ticker}-${Date.now()}`,
        params: { ticker, filings: selected.map(filingMaterialMeta) },
      }).catch(() => undefined);
    }
    return json({
      status: "synced",
      ticker,
      requested: selected.map(f => ({ accession: f.accessionNumber, form: f.form, filedAt: f.filingDate })),
    }, 202);
  }
  if (parts[0] === "materials" && TICKER_PATTERN.test(parts[1] ?? "") && ACCESSION.test(parts[2] ?? "")) {
    const ticker = parts[1]!, accession = parts[2]!;
    if (request.method === "POST" && parts.length === 4 && parts[3] === "reconcile-source") {
      const body=await request.text();if(new TextEncoder().encode(body).length>131072)return json({error:"Reconciliation body too large"},413);
      try { return json(await reconcileImageSource(env,ticker,accession,sourceReconciliationSchema.parse(JSON.parse(body)))); }
      catch(error){return json({error:error instanceof Error?error.message:String(error)},409);}
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "prepare-pilot") return preparePilotMaterial(request, env, ticker, accession);
    const state = await readFilingMaterialState(env, ticker, accession);
    if (!state) return json({ error: "未找到该申报材料。" }, 404);
    if (request.method === "POST" && parts.length === 4 && parts[3] === "review") {
      const body = await request.json().catch(() => null) as { decision?: string; note?: string } | null;
      if (body?.decision !== "approved" && body?.decision !== "rejected") return json({ error: "请选择审批结论（通过或驳回）。" }, 400);
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
      const review: MaterialReview = {
        decision: body.decision,
        version: state.status === "ready" ? state.ref.version : null,
        ...(note ? { note } : {}),
        reviewedAt: new Date().toISOString(),
      };
      await env.DB.prepare("INSERT INTO sec_cache (cache_key, payload, fetched_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at")
        .bind(materialReviewKey(ticker, accession), JSON.stringify(review), review.reviewedAt).run();
      return json({ status: "saved", review });
    }
    if (request.method === "POST" && parts.length === 4 && parts[3] === "prepare") {
      if (await isPilotMaterial(env, ticker, accession)) return json({ error: "This accession is reserved for explicit shadow preparation; use prepare-pilot" }, 409);
      const body = await request.text();
      let options: { retryFailedSources?: boolean; requestId?: string };
      try {
        options = body ? JSON.parse(body) : {};
        if (!options || typeof options !== "object" || Array.isArray(options) || (options.retryFailedSources !== undefined && typeof options.retryFailedSources !== "boolean")) throw new Error("invalid options");
      } catch { return json({ error: "Invalid material preparation options" }, 400); }
      if (options.retryFailedSources === true) {
        if (typeof options.requestId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.requestId)) return json({error:"Failed-source retry requires a UUID requestId"},400);
        const receiptKey = `${materialRecoveryKey(ticker, accession)}:${options.requestId}`;
        const receipt = await env.DB.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(receiptKey).first();
        if (receipt) return json({ ...state, recoveryRequestId: options.requestId, reused: true }, 200);
        if (state.status !== "blocked") return json({error:"Explicit failed-source recovery requires a blocked material"},409);
        const pending: MaterialState = { status: "preparing", filing: state.filing, progress: "one explicit retry of failed sources; successful receipts retained" };
        const at = new Date().toISOString(), payload = JSON.stringify({ requestId: options.requestId, requestedAt: at });
        const first = "EXISTS (SELECT 1 FROM sec_cache WHERE cache_key=? AND json_extract(payload,'$.pending')=1)";
        await env.DB.batch([
          env.DB.prepare("INSERT INTO sec_cache(cache_key,payload,fetched_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO NOTHING").bind(receiptKey,JSON.stringify({...JSON.parse(payload),pending:true}),at),
          env.DB.prepare(`INSERT INTO sec_cache(cache_key,payload,fetched_at) SELECT ?,?,? WHERE ${first} ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,fetched_at=excluded.fetched_at`).bind(materialRecoveryKey(ticker,accession),payload,at,receiptKey),
          env.DB.prepare(`UPDATE sec_cache SET payload=?,fetched_at=? WHERE cache_key=? AND ${first}`).bind(JSON.stringify(pending),at,materialStateKey(ticker,accession),receiptKey),
          outboxStatement(env.DB,{type:"filing.material.requested",ticker,cik:state.filing.cik,detail:{accession,form:state.filing.form}},at,{sql:first,binds:[receiptKey]}),
          env.DB.prepare(`UPDATE sec_cache SET payload=json_remove(payload,'$.pending') WHERE cache_key=? AND ${first}`).bind(receiptKey,receiptKey),
        ]);
        await flushOutbox(env);
        const prepareRunner = withRuns(env).MATERIAL_PREPARE_WORKFLOW;
        if (prepareRunner) {
          await prepareRunner.create({
            id: `material-prepare-${ticker}-${accession}-${Date.now()}`,
            params: { ticker, filings: [state.filing], recoveryRequestId: options.requestId },
          }).catch(() => undefined);
        }
        return json({...pending,recoveryRequestId:options.requestId,reused:false},202);
      }
      const pending: MaterialState = { status: "preparing", filing: state.filing, progress: "awaiting accession archive" };
      await env.DB.batch([
        env.DB.prepare("UPDATE sec_cache SET payload = ?, fetched_at = ? WHERE cache_key = ?")
          .bind(JSON.stringify(pending), new Date().toISOString(), materialStateKey(ticker, accession)),
        outboxStatement(env.DB, { type: "filing.material.requested", ticker, cik: state.filing.cik, detail: { accession, form: state.filing.form } }),
      ]);
      await flushOutbox(env);
      const prepareRunner = withRuns(env).MATERIAL_PREPARE_WORKFLOW;
      if (prepareRunner) {
        await prepareRunner.create({
          id: `material-prepare-${ticker}-${accession}-${Date.now()}`,
          params: { ticker, filings: [state.filing] },
        }).catch(() => undefined);
      }
      return json(pending, 202);
    }
    if (parts[3] === "brief" && parts.length === 4) {
      if (state.status !== "ready") return json({ error: "财报材料尚未就绪。" }, 409);
      let body: { version?: unknown; force?: unknown } = {};
      if (request.method === "POST") {
        const raw = await request.text();
        if (raw) {
          try { body = JSON.parse(raw) as { version?: unknown; force?: unknown }; }
          catch { return json({ error: "无效的请求参数。" }, 400); }
        }
      }
      const version = typeof body.version === "string" ? body.version : url.searchParams.get("version") ?? state.ref.version;
      if (!/^[a-f0-9]{64}$/.test(version)) return json({ error: "无效的材料版本。" }, 400);
      const ref = { ticker, accession, version };
      await readMaterialSnapshot(env, ref);
      if (request.method === "GET") {
        return json(await readMaterialBrief(env, ref));
      }
      if (request.method === "POST") {
        const force = body.force === true;
        const current = await getMaterialBriefState(env, ref);
        if (current.status === "running" && !force) return json({ state: current }, 202);
        if (!force) {
          const existing = await readMaterialBrief(env, ref);
          if (existing.brief) return json(existing, 200);
        }
        const runEnv = withRuns(await aiToolEnvironment(env));
        const binding = runEnv.MATERIAL_BRIEF_WORKFLOW;
        if (!binding) return json({ error: "L2 抽取任务服务不可用。" }, 503);
        const runId = `material-brief-${ticker}-${accession}-${Date.now()}`;
        const model = modelFor(runEnv, "filing-read");
        const running = { status: "running" as const, runId, model, startedAt: new Date().toISOString(), version };
        await writeMaterialBriefState(env, ref, running);
        try {
          await binding.create({ id: runId, params: { ticker, accession, version, runId, force } });
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
          await writeMaterialBriefState(env, ref, { status: "failed", runId, version, model, failedAt: new Date().toISOString(), error: message });
          return json({ error: message }, 503);
        }
        return json({ state: running }, 202);
      }
    }
    if (request.method === "GET") {
      if (parts.length === 3) {
        const [pilot, revRow, stateRow, leaseRow] = await Promise.all([
          env.DB.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(materialPilotKey(ticker,accession)).first<{payload:string}>(),
          env.DB.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(materialReviewKey(ticker,accession)).first<{payload:string}>(),
          env.DB.prepare("SELECT fetched_at FROM sec_cache WHERE cache_key=?").bind(materialStateKey(ticker,accession)).first<{fetched_at:string}>(),
          state.status === "preparing"
            ? env.DB.prepare("SELECT payload FROM sec_cache WHERE cache_key=?").bind(leaseKey(state.filing)).first<{payload:string}>()
            : Promise.resolve(null),
        ]);
        const updatedAt = state.status === "preparing" ? (state.updatedAt ?? stateRow?.fetched_at) : undefined;
        let stalled = false;
        if (state.status === "preparing" && state.progress !== "awaiting accession archive" && updatedAt) {
          const lastMs = Date.parse(updatedAt);
          let leaseExpired = true;
          if (leaseRow?.payload) {
            try {
              const lease = JSON.parse(leaseRow.payload) as { expiresAt?: number };
              leaseExpired = !lease.expiresAt || lease.expiresAt <= Date.now();
            } catch { leaseExpired = true; }
          }
          stalled = Number.isFinite(lastMs) && (Date.now() - lastMs > 3 * 60_000) && leaseExpired;
        }
        let resolvedFiles = state.status !== "ready" ? state.files : undefined;
        if ((state.status === "preparing" || state.status === "blocked") && (!resolvedFiles || resolvedFiles.length === 0)) {
          resolvedFiles = await readExtractionFiles(env, state.filing, { stalled }).catch(() => []);
        } else if (state.status === "preparing" && resolvedFiles && resolvedFiles.length > 0) {
          const copy = resolvedFiles.map(f => ({ ...f }));
          const hasAssemble = copy.some(f => f.type === "ASSEMBLE" || f.filename === ASSEMBLE_STEP_FILENAME);
          if (!hasAssemble) {
            const allDone = copy.every(f => f.status === "done");
            copy.push({
              filename: ASSEMBLE_STEP_FILENAME,
              type: "ASSEMBLE",
              status: stalled && allDone ? "failed" : allDone ? "extracting" : "pending",
            });
          }
          if (stalled) {
            const active = copy.find(f => f.status === "extracting") ?? copy.find(f => f.status === "pending");
            if (active) active.status = "failed";
          }
          resolvedFiles = copy;
        }
        const review = revRow ? JSON.parse(revRow.payload) as MaterialReview : null;
        return json({
          ...state,
          ...(updatedAt ? { updatedAt } : {}),
          ...(stalled ? { stalled: true } : {}),
          ...(resolvedFiles && resolvedFiles.length ? { files: resolvedFiles } : {}),
          review,
          ...(pilot ? { pilot:JSON.parse(pilot.payload), resumeRequired:JSON.parse(pilot.payload).chunkStatus === "preparing" } : {}),
        });
      }
      if (state.status !== "ready") return json(state, 409);
      const snapshot = await readMaterialSnapshot(env, { ...state.ref, version: url.searchParams.get("version") ?? state.ref.version });
      if (parts.length === 4 && parts[3] === "index") return json(snapshot);
      if (parts.length === 4 && parts[3] === "markdown") return json(await readFilingMarkdown(env, snapshot, {
        anchor: url.searchParams.get("anchor") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined,
      }));
      if (parts.length === 4 && parts[3] === "tables") {
        const found = findFilingTables(snapshot, {
          name: url.searchParams.get("name") ?? undefined, cursor: url.searchParams.get("cursor") ?? undefined,
        });
        const briefRes = await readMaterialBrief(env, snapshot.ref).catch(() => null);
        const descMap = briefTableDescriptionMap(briefRes?.brief ?? null);
        return json({
          ...found,
          tables: found.tables.map(table => {
            const enriched = descMap.get(table.tableId);
            return enriched ? { ...table, description: enriched } : table;
          }),
        });
      }
      if (parts.length === 5 && parts[3] === "tables") {
        const page = readFilingTable(snapshot, parts[4]!, {
          cursor: url.searchParams.get("cursor") ?? undefined,
        });
        const briefRes = await readMaterialBrief(env, snapshot.ref).catch(() => null);
        const enriched = briefTableDescriptionMap(briefRes?.brief ?? null).get(page.table.tableId);
        return json(enriched ? { ...page, table: { ...page.table, description: enriched } } : page);
      }
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
