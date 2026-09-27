import fallbackSnapshotData from "../data/portfolio-snapshot.json" with { type: "json" };

import { shanghaiDate } from "./portfolio-history.ts";
import type { FlexRawSyncInput } from "./ibkr-flex.ts";
import {
  buildPortfolioSnapshot,
  canonicalUnderlying,
  normalizeIbkrPosition,
  normalizeIbkrTrade,
  type PortfolioSnapshotV1,
} from "./portfolio-snapshot.ts";

type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  first<T>(): Promise<T | null>;
};

export type PortfolioDatabase = {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<Array<{ meta: { changes: number } }>>;
};

const FALLBACK_SNAPSHOT = fallbackSnapshotData as PortfolioSnapshotV1;
const FALLBACK_SYMBOL_BY_POSITION_KEY = new Map(
  FALLBACK_SNAPSHOT.positions.map((position) => [position.positionKey, position.symbol]),
);

function repairLegacyFlexSymbols(snapshot: PortfolioSnapshotV1): PortfolioSnapshotV1 {
  if (snapshot.source?.method !== "FLEX") return snapshot;

  let changed = false;
  const positions = snapshot.positions.map((position) => {
    const knownSymbol = FALLBACK_SYMBOL_BY_POSITION_KEY.get(position.positionKey);
    const legacyDerivedSymbol = canonicalUnderlying(position.contractDescription.split(/\s+/)[0] ?? "");
    if (!knownSymbol || knownSymbol === position.symbol || position.symbol !== legacyDerivedSymbol) return position;
    changed = true;
    return { ...position, symbol: knownSymbol };
  });
  return changed ? { ...snapshot, positions } : snapshot;
}

function decodeSnapshot(payload: string | null): PortfolioSnapshotV1 {
  if (!payload) return FALLBACK_SNAPSHOT;
  const snapshot = JSON.parse(payload) as PortfolioSnapshotV1;
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.positions) || !Array.isArray(snapshot.trades)) {
    throw new Error("Stored portfolio snapshot is invalid");
  }
  return repairLegacyFlexSymbols(snapshot);
}

async function readStoredPayload(database: Pick<PortfolioDatabase, "prepare">): Promise<string | null> {
  const row = await database.prepare("SELECT payload FROM portfolio_state WHERE id = 'current'").first<{ payload: string }>();
  return row?.payload ?? null;
}

/** Distinguish an absent live record from the bundled fallback. */
export async function readPortfolioSnapshotWithSource(database: Pick<PortfolioDatabase, "prepare">) {
  const payload = await readStoredPayload(database);
  return { snapshot: decodeSnapshot(payload), source: payload ? "live" as const : "fallback" as const };
}

export async function readPortfolioSnapshot(database: Pick<PortfolioDatabase, "prepare">): Promise<PortfolioSnapshotV1> {
  return decodeSnapshot(await readStoredPayload(database));
}

function reportIsOlder(previous: PortfolioSnapshotV1, raw: FlexRawSyncInput): boolean {
  if (previous.source?.method !== "FLEX" || !previous.source.reportDate) return false;
  return raw.source.reportDate < previous.source.reportDate
    || (raw.source.reportDate === previous.source.reportDate
      && Date.parse(raw.generatedAt) < Date.parse(previous.generatedAt));
}

// Fetch time and query window describe the sync, not a change to portfolio data.
function snapshotContent(snapshot: PortfolioSnapshotV1): string {
  return JSON.stringify({
    account: snapshot.account,
    positions: [...snapshot.positions].sort((a, b) => a.positionKey.localeCompare(b.positionKey)),
    trades: snapshot.trades,
    capitalFlows: snapshot.capitalFlows,
    source: snapshot.source,
    tradeStatus: snapshot.tradeSync.status,
  });
}

export async function publishFlexSnapshot(
  database: PortfolioDatabase,
  raw: FlexRawSyncInput,
): Promise<{ status: "published" | "unchanged"; snapshot: PortfolioSnapshotV1 }> {
  if (raw.source.method !== "FLEX") throw new Error("Portfolio sync source must be IBKR Flex");
  if (!Number.isFinite(Date.parse(raw.generatedAt))
    || !/^\d{4}-\d{2}-\d{2}$/.test(raw.source.reportDate)
    || new Date(raw.source.reportDate).toISOString().slice(0, 10) !== raw.source.reportDate) {
    throw new Error("Portfolio report dates are invalid");
  }
  const usdBalance = raw.balances.balances.find((balance) => balance.currency === "USD");
  const positions = raw.positions.positions
    .filter((position) => position.asset_class === "STK" || position.asset_class === "OPT")
    .map(normalizeIbkrPosition);
  const trades = raw.trades.trades.map(normalizeIbkrTrade);

  // Compare-and-swap the exact payload that supplied the trade/capital-flow history.
  // A losing writer must reread and merge again, never overwrite a newer merge.
  for (let attempt = 0; attempt < 4; attempt++) {
    const previousPayload = await readStoredPayload(database);
    const previous = decodeSnapshot(previousPayload);
    if (reportIsOlder(previous, raw)) return { status: "unchanged", snapshot: previous };
    const snapshot = buildPortfolioSnapshot(previous, {
      capitalFlows: raw.capitalFlows,
      generatedAt: raw.generatedAt,
      account: { netLiquidation: raw.summary.net_liquidation, cashBalance: usdBalance?.cash_balance ?? Number.NaN },
      positions,
      source: raw.source,
      tradeSync: { status: "current", queryPeriod: raw.queryPeriod, trades },
    });
    if (snapshotContent(snapshot) === snapshotContent(previous)) return { status: "unchanged", snapshot: previous };
    const snapshotStatement = database.prepare(`
      INSERT INTO portfolio_state (id, report_date, generated_at, payload, updated_at)
      VALUES ('current', ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        report_date = excluded.report_date,
        generated_at = excluded.generated_at,
        payload = excluded.payload,
        updated_at = CURRENT_TIMESTAMP
      WHERE portfolio_state.payload = ?
    `).bind(raw.source.reportDate, snapshot.generatedAt, JSON.stringify(snapshot), previousPayload);
    // changes() refers to the preceding CAS within this atomic D1 batch. A losing
    // writer must not create or overwrite a history row either.
    const historyStatement = database.prepare(`
      INSERT INTO portfolio_history (date, generated_at, net_liquidation, net_deposits)
      SELECT ?, ?, ?, ? WHERE changes() = 1
      ON CONFLICT(date) DO UPDATE SET
        generated_at = excluded.generated_at,
        net_liquidation = excluded.net_liquidation,
        net_deposits = excluded.net_deposits
    `).bind(shanghaiDate(snapshot.generatedAt), snapshot.generatedAt, String(snapshot.account.netLiquidation), String(snapshot.account.netDeposits));
    const results = await database.batch([snapshotStatement, historyStatement]);
    if (results[0].meta.changes === 1) return { status: "published", snapshot };
  }
  throw new Error("Portfolio sync conflicted with another writer; retry the report");
}
