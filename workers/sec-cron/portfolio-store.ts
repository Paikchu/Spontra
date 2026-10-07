import { shanghaiDate } from "../../lib/portfolio-history.ts";
import { portfolioSyncOverdue, type PortfolioApiResponseV1 } from "../../shared/portfolio-contract.ts";
import type { FlexRawSyncInput } from "../../lib/ibkr-flex.ts";
import {
  buildPortfolioSnapshot,
  canonicalUnderlying,
  normalizeIbkrPosition,
  normalizeIbkrTrade,
  type PortfolioSnapshotV1,
} from "../../lib/portfolio-snapshot.ts";

type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  first<T>(): Promise<T | null>;
};

export type PortfolioDatabase = {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<Array<{ meta: { changes: number } }>>;
};

// Known contract symbols repair legacy snapshots without bundling any account data.
const LEGACY_SYMBOL_BY_POSITION_KEY = new Map<string, string>([
  [
    "STK:3691937",
    "AMZN"
  ],
  [
    "STK:313130367",
    "AVGO"
  ],
  [
    "STK:870556708",
    "DRAM"
  ],
  [
    "STK:208813719",
    "GOOGL"
  ],
  [
    "OPT:845712739",
    "INTC"
  ],
  [
    "STK:107113386",
    "META"
  ],
  [
    "STK:483492393",
    "MRVL"
  ],
  [
    "STK:272093",
    "MSFT"
  ],
  [
    "STK:272110",
    "MSTR"
  ],
  [
    "STK:109911821",
    "NOW"
  ],
  [
    "STK:4815747",
    "NVDA"
  ],
  [
    "OPT:730765112",
    "NVDA"
  ],
  [
    "STK:272800",
    "ORCL"
  ],
  [
    "STK:890493863",
    "SPCX"
  ],
  [
    "STK:76792991",
    "TSLA"
  ],
  [
    "STK:136155102",
    "VOO"
  ]
]);

function repairLegacyFlexSymbols(snapshot: PortfolioSnapshotV1): PortfolioSnapshotV1 {
  if (snapshot.source?.method !== "FLEX") return snapshot;

  let changed = false;
  const positions = snapshot.positions.map((position) => {
    const knownSymbol = LEGACY_SYMBOL_BY_POSITION_KEY.get(position.positionKey);
    const legacyDerivedSymbol = canonicalUnderlying(position.contractDescription.split(/\s+/)[0] ?? "");
    if (!knownSymbol || knownSymbol === position.symbol || position.symbol !== legacyDerivedSymbol) return position;
    changed = true;
    return { ...position, symbol: knownSymbol };
  });
  return changed ? { ...snapshot, positions } : snapshot;
}

function decodeSnapshot(payload: string): PortfolioSnapshotV1 {
  const snapshot = JSON.parse(payload) as PortfolioSnapshotV1;
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.positions) || !Array.isArray(snapshot.trades)) {
    throw new Error("Stored portfolio snapshot is invalid");
  }
  return repairLegacyFlexSymbols(snapshot);
}

type StoredPortfolio = {
  payload: string;
  report_date: string;
  synced_at: string;
  successful_attempt_at: string;
  status: "success" | "failed" | null;
};

async function readStoredPortfolio(database: Pick<PortfolioDatabase, "prepare">) {
  return database.prepare(`SELECT s.payload, s.report_date, s.synced_at, s.successful_attempt_at, a.status
    FROM portfolio_state s LEFT JOIN portfolio_sync_attempt a ON a.id = s.id WHERE s.id = 'current'`)
    .first<StoredPortfolio>();
}

export async function readPortfolioSnapshot(database: Pick<PortfolioDatabase, "prepare">): Promise<PortfolioSnapshotV1 | null> {
  const row = await readStoredPortfolio(database);
  return row ? decodeSnapshot(row.payload) : null;
}

export async function readPortfolioResponse(database: Pick<PortfolioDatabase, "prepare">, now = new Date()): Promise<PortfolioApiResponseV1> {
  const row = await readStoredPortfolio(database);
  if (!row) return { portfolio: null, reportDate: null, syncedAt: null, syncStatus: "uninitialized" };
  const snapshot = decodeSnapshot(row.payload);
  // Explicit projection prevents new private storage fields leaking into the API.
  const { schemaVersion, generatedAt, account, positions, trades, tradeSync } = snapshot;
  return {
    portfolio: { schemaVersion, generatedAt, account, positions, trades, tradeSync },
    reportDate: row.report_date,
    syncedAt: row.synced_at,
    syncStatus: row.status === "failed" || portfolioSyncOverdue(row.synced_at, now) ? "delayed" : "current",
  };
}

function attemptStatement(database: PortfolioDatabase, startedAt: string, status: "success" | "failed", afterWrite = false) {
  return database.prepare(`INSERT INTO portfolio_sync_attempt (id, started_at, status)
    SELECT 'current', ?, ? ${afterWrite ? "WHERE changes() = 1" : "WHERE 1"}
    ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, status = excluded.status
    WHERE excluded.started_at >= portfolio_sync_attempt.started_at`).bind(startedAt, status);
}

export async function recordSyncFailure(database: PortfolioDatabase, startedAt: string) {
  await database.batch([attemptStatement(database, startedAt, "failed")]);
}

function emptySnapshot(generatedAt: string): PortfolioSnapshotV1 {
  return { schemaVersion: 1, generatedAt, account: { currency: "USD", netLiquidation: 0, cashBalance: 0, netDeposits: 0 },
    positions: [], trades: [], tradeSync: { status: "current", queryPeriod: "YEAR_TO_DATE", lastSuccessfulTradeAt: null, message: null } };
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
  completedAt: string = raw.generatedAt,
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
  const startedAt = new Date(raw.generatedAt).toISOString();
  const syncedAt = new Date(completedAt).toISOString();

  // Compare-and-swap the exact payload that supplied the trade/capital-flow history.
  // A losing writer must reread and merge again, never overwrite a newer merge.
  for (let attempt = 0; attempt < 4; attempt++) {
    const stored = await readStoredPortfolio(database);
    const previousPayload = stored?.payload ?? null;
    const previous = previousPayload ? decodeSnapshot(previousPayload) : emptySnapshot(startedAt);
    if (reportIsOlder(previous, raw)
      || (stored && startedAt < stored.successful_attempt_at)) {
      return { status: "unchanged", snapshot: previous };
    }
    const snapshot = buildPortfolioSnapshot(previous, {
      capitalFlows: raw.capitalFlows,
      generatedAt: raw.generatedAt,
      account: { netLiquidation: raw.summary.net_liquidation, cashBalance: usdBalance?.cash_balance ?? Number.NaN },
      positions,
      source: raw.source,
      tradeSync: { status: "current", queryPeriod: raw.queryPeriod, trades },
    });
    if (stored && snapshotContent(snapshot) === snapshotContent(previous)) {
      const results = await database.batch([
        database.prepare(`UPDATE portfolio_state SET synced_at = ?, successful_attempt_at = ?
          WHERE id = 'current' AND payload = ? AND successful_attempt_at = ?`)
          .bind(syncedAt, startedAt, previousPayload, stored.successful_attempt_at),
        attemptStatement(database, startedAt, "success", true),
      ]);
      if (results[0].meta.changes === 1) return { status: "unchanged", snapshot: previous };
      continue;
    }
    const snapshotStatement = database.prepare(`
      INSERT INTO portfolio_state (id, report_date, generated_at, payload, updated_at, synced_at, successful_attempt_at)
      VALUES ('current', ?, ?, ?, CURRENT_TIMESTAMP, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        report_date = excluded.report_date,
        generated_at = excluded.generated_at,
        payload = excluded.payload,
        updated_at = CURRENT_TIMESTAMP,
        synced_at = excluded.synced_at,
        successful_attempt_at = excluded.successful_attempt_at
      WHERE portfolio_state.payload = ? AND portfolio_state.successful_attempt_at = ?
    `).bind(raw.source.reportDate, snapshot.generatedAt, JSON.stringify(snapshot), syncedAt, startedAt, previousPayload, stored?.successful_attempt_at ?? null);
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
    const results = await database.batch([snapshotStatement, historyStatement, attemptStatement(database, startedAt, "success", true)]);
    if (results[0].meta.changes === 1) return { status: "published", snapshot };
  }
  throw new Error("Portfolio sync conflicted with another writer; retry the report");
}
