import { z } from "zod";
import type { FinancialStatements, StatementCell, StatementTable } from "./financial-statements.ts";
import type {
  AssetGroup, BalanceSheet, CapitalFiling, CapitalLine, CapitalQuarter, CapitalSource, CashFlowSection, CashFlowStatement,
  EquityGroup, FinancingGroup, InvestingGroup, LiabilityGroup, OperatingGroup, PublicCapitalStructure, SupplementalGroup,
} from "../../analysis-contract/capital-structure.ts";

/**
 * Balance sheet and cash flow statement lines, read from the filing's own statement tables.
 * Rows, labels and order are the issuer's presentation; amounts come only from the XBRL facts tagged in
 * those cells, signed as the statement shows them. A statement is published only when its lines add up
 * to the totals the issuer reports; anything else is dropped, never estimated.
 */
export const CAPITAL_VERSION = "sec-capital-structure.v1";

type Fact = StatementCell["facts"][number];
type Row = { label: string; concept: string; value: number | null };
type Line<G extends string> = Row & { value: number; group: G };
type Kind = "balance" | "cashflow";

const local = (concept: string) => concept.split(":").at(-1)!;
const days = (start: string, end: string) => (Date.parse(end) - Date.parse(start)) / 86400000;
const nextDay = (date: string) => new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10);
const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 1e-9);
const sum = (rows: Array<{ value: number }>) => rows.reduce((total, row) => total + row.value, 0);
const currencyOf = (fact: Fact) => fact.unit?.match(/^iso4217:([A-Z]{3})$/)?.[1] ?? null;
const amountFact = (fact: Fact) => fact.status === "parsed" && fact.value !== null && /^-?\d+(?:\.\d+)?$/.test(fact.value) && currencyOf(fact) !== null;
const monetary = (fact: Fact) => amountFact(fact) && !fact.dimensions.length;
const decoration = /^(?:[$€£¥()%]|US\$|\)|—|–|-)?$/;

function statementKind(table: StatementTable): Kind | null {
  const kind = (text: string): Kind | null => /parenthetical/i.test(text) ? null
    : /\bbalance sheets?\b|\bstatements? of financial (?:position|condition)\b/i.test(text) ? "balance"
    : /\bstatements? of cash flows?\b|\bcash flows? statements?\b/i.test(text) ? "cashflow" : null;
  const heading = table.section.trim();
  if (/^(?:notes?\b|\d{1,2}[.\s:–—-]+\D)/i.test(heading)) return null;
  if (/\bstatements? of (?:income|operations|earnings|comprehensive|stockholders|shareholders|changes)/i.test(heading)) return null;
  // A table under the chapter heading is identified by the statement title printed right above it.
  return kind(heading) ?? kind(table.precedingText.slice(-300));
}

/** The first statement of this kind; a statement split across pages continues under the same heading. */
function statementTables(statements: FinancialStatements, kind: Kind): StatementTable[] {
  const start = statements.tables.findIndex(t => statementKind(t) === kind);
  if (start < 0) return [];
  const run = [statements.tables[start]];
  for (const table of statements.tables.slice(start + 1)) {
    if (table.section !== run[0].section || statementKind(table) !== kind) break;
    run.push(table);
  }
  return run;
}

const labelCell = (row: StatementTable["rows"][number]) => row.cells.find(c => c.text.trim() && !decoration.test(c.text.trim()) && !/^\(?[\d,.\s]+\)?$/.test(c.text.trim()));
const cleanLabel = (text: string) => text.replace(/\s*\((?:\d{1,2}|[a-z])\)\s*$/i, "").replace(/[:：]\s*$/, "").trim();

/** Amounts carry the statement's sign: a payment tagged as a positive fact but printed in parentheses is an outflow. */
function rows(tables: StatementTable[], period: (fact: Fact) => boolean): { rows: Row[]; currencies: Set<string> } {
  const result: Row[] = [], currencies = new Set<string>();
  for (const table of tables) for (const row of table.rows) {
    const caption = labelCell(row), label = cleanLabel(caption?.text ?? "");
    let value: number | null = null, concept = "";
    // Amounts quoted inside the caption (an allowance, a par value) describe the row; they are not its amount.
    for (const cell of row.cells) {
      if (cell === caption) continue;
      // The printed amount is the cell's fact; some issuers tag a face-statement line with a member, so a dimensional fact is used when it is the only one.
      const candidates = cell.facts.filter(f => amountFact(f) && period(f)), fact = candidates.find(monetary) ?? candidates[0];
      if (!fact) continue;
      const next = row.cells.find(c => c.column === cell.column + cell.colSpan);
      const negative = cell.text.includes("(") || /^\)/.test(next?.text.trim() ?? "") || /^[-−–]\s*[$\d]/.test(cell.text.trim());
      const magnitude = Math.abs(Number(fact.value));
      value = negative ? -magnitude : magnitude;
      concept = fact.concept;
      currencies.add(currencyOf(fact)!);
      break;
    }
    if (label || value !== null) result.push({ label, concept, value });
  }
  return { rows: result, currencies };
}

/**
 * The rows must add up to the reported total. A row equal to the sum of the rows directly above it
 * (since the previous such row) is an unlabelled subtotal, such as net property after accumulated
 * depreciation; it is dropped only when that is what makes the section reconcile.
 */
function reconcile<T extends { value: number }>(items: T[], total: number): T[] | null {
  if (near(sum(items), total)) return items;
  const kept: T[] = [];
  let runStart = 0;
  for (const item of items) {
    let subtotal = false;
    for (let j = runStart; j <= kept.length - 2 && !subtotal; j++) subtotal = near(sum(kept.slice(j)), item.value);
    if (subtotal) runStart = kept.length;
    else kept.push(item);
  }
  return near(sum(kept), total) ? kept : null;
}

/** Rules test the concept and the issuer's label separately, so anchors apply to each. */
function classify<G extends string>(row: Row, rules: Array<[G, RegExp]>, fallback: G): G {
  return rules.find(([, pattern]) => pattern.test(local(row.concept)) || pattern.test(row.label))?.[0] ?? fallback;
}

const ASSET_RULES: Array<[AssetGroup, RegExp]> = [
  ["leaseAssets", /OperatingLeaseRightOfUse|operating lease right[- ]of[- ]use/i],
  ["investments", /Noncurrent.*(?:Securities|Investments)|(?:Securities|Investments).*Noncurrent|LongTermInvestments|EquityMethod|long-term investments|strategic investments/i],
  ["cash", /\bcash\b|CashAndCashEquivalents|RestrictedCash|MarketableSecurities|ShortTermInvestments|AvailableForSaleSecurities|marketable securities|short-term investments/i],
  ["receivables", /Receivable|receivable/i],
  ["inventory", /Inventor/i],
  ["intangibles", /Goodwill|Intangible/i],
  ["productive", /PropertyPlant|property|equipment|FinanceLeaseRightOfUse|AccumulatedDepreciation|LeasedAssets|DeferredCostsLeasing|lease vehicles/i],
  ["investments", /Investment/i],
];
const LIABILITY_RULES: Array<[LiabilityGroup, RegExp]> = [
  ["leases", /(?:Operating|Finance)LeaseLiabilit|CapitalLeaseObligation|lease liabilit|lease obligation/i],
  ["customerAdvances", /ContractWithCustomerLiabilit|DeferredRevenue|CustomerDeposit|CustomerAdvance|deferred revenue|unearned revenue|customer (?:deposits|advances|prepayments)|contract liabilit/i],
  ["deferredTax", /DeferredIncomeTax|DeferredTax|deferred (?:income )?tax/i],
  ["debt", /Debt|Borrowing|NotesPayable|LoansPayable|CommercialPaper|LineOfCredit|ConvertibleNotes|SeniorNotes|\bdebt\b|borrowings|notes payable|credit facilit|term loan|convertible (?:senior )?notes|senior notes/i],
  ["payables", /AccountsPayable|Accrued|InterestPayable|TaxesPayable|EmployeeRelated|payable|accrued/i],
];
const EQUITY_RULES: Array<[EquityGroup, RegExp]> = [
  ["redeemable", /TemporaryEquity|RedeemableNoncontrolling|redeemable/i],
  ["noncontrolling", /MinorityInterest|noncontrolling|non-controlling/i],
  ["retained", /RetainedEarnings|AccumulatedDeficit|retained earnings|accumulated deficit/i],
  ["otherEquity", /AccumulatedOtherComprehensive|other comprehensive/i],
  ["paidIn", /CommonStock|PreferredStock|AdditionalPaidIn|TreasuryStock|paid-in|common stock|preferred stock|treasury|capital/i],
];
const INVESTING_RULES: Array<[InvestingGroup, RegExp]> = [
  ["capex", /PaymentsToAcquire(?:PropertyPlantAndEquipment|ProductiveAssets|OtherPropertyPlantAndEquipment)|PaymentsForCapitalImprovements|capital expenditure|purchases? of property|purchases? of (?:property|equipment)|additions to property/i],
  ["acquisitions", /AcquireBusinesses|business combination|acquisitions?,? net of cash/i],
  ["investments", /Securities|Investment|JointVenture|NotesReceivable|marketable|investments?|maturities/i],
];
const FINANCING_RULES: Array<[FinancingGroup, RegExp]> = [
  ["leasePrincipal", /FinanceLeasePrincipal|CapitalLeaseObligations|finance lease/i],
  ["equityIssued", /ProceedsFromIssuanceOf\w*(?:CommonStock|PrivatePlacement|InitialPublicOffering|PreferredStock|Warrants)|ProceedsFromStockOptionsExercised|ProceedsFromStockPlans|ProceedsFromIssuanceOfSharesUnder|EmployeeStockPurchase|issuances? of [^,;]*?(?:common|preferred|ordinary) (?:stock|shares)|initial public offering|private placement|exercises? of (?:stock )?options|at-the-market|employee stock purchase/i],
  ["debtRepaid", /^Repayments|RepaymentsOf|repayments? of|principal payments on|redemptions? of (?:notes|debt|convertible)|extinguishment/i],
  ["debtIssued", /^ProceedsFrom.*(?:Debt|Notes|Borrowing|LinesOfCredit|Loan|CommercialPaper)|proceeds from (?:the )?(?:issuance of )?(?:debt|notes|borrowings|term loans?|credit facilit|convertible|senior)|borrowings under/i],
  ["buybacks", /PaymentsForRepurchaseOf(?:Common|Equity)|repurchases? of (?:common |class [a-z] )?(?:stock|shares)|share repurchase|treasury stock/i],
  ["dividends", /PaymentsOfDividends|dividends? paid|payments? of dividends/i],
];
/** Borrowings are often presented net ("proceeds from (repayments of) commercial paper"); the amount's sign says which way cash moved. */
const debtBySign = (group: FinancingGroup, value: number): FinancingGroup => group === "debtIssued" || group === "debtRepaid" ? value >= 0 ? "debtIssued" : "debtRepaid" : group;
const SUPPLEMENTAL_RULES: Array<[SupplementalGroup, RegExp]> = [
  ["interestPaid", /InterestPaid|paid for interest/i],
  ["taxesPaid", /IncomeTaxesPaid|paid for (?:income )?taxes/i],
  ["unpaidCapex", /CapitalExpendituresIncurredButNotYetPaid|^(?:liabilities|accounts payable|accrued)[^.]*(?:property|equipment)|(?:property|equipment)[^.]*(?:included in|in) (?:accounts payable|accrued)|^unpaid/i],
  ["leaseAssetsObtained", /RightOfUseAssetObtainedInExchange|right-of-use assets? (?:obtained|acquired)/i],
];

const sideTotals: Record<string, "assets" | "currentAssets" | "liabilities" | "currentLiabilities" | "balancing" | "parentEquity" | "equity" | "subtotal"> = {
  Assets: "assets", AssetsCurrent: "currentAssets", AssetsNoncurrent: "subtotal", Liabilities: "liabilities", LiabilitiesCurrent: "currentLiabilities",
  LiabilitiesNoncurrent: "subtotal", LiabilitiesAndStockholdersEquity: "balancing", StockholdersEquity: "parentEquity",
  StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: "equity", TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterests: "subtotal",
};
const equityStarts = (row: Row) => /^(?:TemporaryEquity|CommonStock|PreferredStockValue|AdditionalPaidInCapital|RetainedEarnings|TreasuryStock|AccumulatedOtherComprehensive|StockholdersEquity|MinorityInterest|RedeemableNoncontrolling)/.test(local(row.concept))
  || /^(?:commitments and contingencies|(?:total )?(?:stockholders|shareholders|members|partners)['’]? (?:equity|deficit)|equity\b|redeemable )/i.test(row.label);

/** Reconciled rows become published lines; rows printed as a dash or zero carry no amount and are left out. */
function ids<G extends string>(lines: Array<Line<G>>): CapitalLine<G>[] {
  const seen = new Map<string, number>();
  return lines.filter(line => line.value !== 0).map(line => {
    const base = local(line.concept) || line.label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { id: count > 1 ? `${base}~${count}` : base, label: line.label, concept: line.concept, group: line.group, value: String(line.value) };
  });
}

export function extractBalanceSheet(statements: FinancialStatements, source: CapitalSource, issues: string[] = []): BalanceSheet | null {
  const tables = statementTables(statements, "balance");
  if (!tables.length) { issues.push("BALANCE_SHEET_NOT_LOCATED"); return null; }
  const instants = tables.flatMap(t => t.rows.flatMap(r => r.cells.flatMap(c => c.facts))).filter(f => monetary(f) && f.period?.kind === "instant" && f.period.end);
  const asOf = instants.map(f => f.period!.end!).sort().at(-1);
  if (!asOf) { issues.push("BALANCE_SHEET_UNTAGGED"); return null; }
  const read = rows(tables, f => f.period?.kind === "instant" && f.period.end === asOf);
  if (read.currencies.size !== 1) { issues.push("BALANCE_SHEET_CURRENCY_MIXED"); return null; }
  const totals: Partial<Record<(typeof sideTotals)[string], number>> = {};
  const leaves = { asset: [] as Row[], liability: [] as Row[], equity: [] as Row[] };
  let side: "asset" | "liability" | "equity" | "done" = "asset";
  for (const row of read.rows) {
    if (side === "done") break;
    const total = sideTotals[local(row.concept)];
    if (total === "assets") { totals.assets = row.value!; side = "liability"; continue; }
    if (total === "balancing") { totals.balancing = row.value!; side = "done"; continue; }
    if (total === "liabilities" && side === "liability") { totals.liabilities = row.value!; side = "equity"; continue; }
    if (side === "liability" && equityStarts(row)) side = "equity";
    if (total) { if (total !== "subtotal") totals[total] = row.value!; continue; }
    if (row.value === null || /^total\b/i.test(row.label)) continue;
    leaves[side].push(row);
  }
  if (totals.assets === undefined || totals.balancing === undefined) { issues.push("BALANCE_SHEET_TOTALS_MISSING"); return null; }
  if (!near(totals.assets, totals.balancing)) { issues.push("BALANCE_SHEET_DOES_NOT_BALANCE"); return null; }
  const assets = reconcile(leaves.asset.map(r => ({ ...r, value: r.value!, group: classify(r, ASSET_RULES, "other") })), totals.assets);
  const equityRows = leaves.equity.map(r => ({ ...r, value: r.value!, group: classify(r, EQUITY_RULES, "paidIn") }));
  const liabilityRows = leaves.liability.map(r => ({ ...r, value: r.value!, group: classify(r, LIABILITY_RULES, "other") }));
  // The liability/equity boundary is verified by a reported total on at least one side of it.
  let liabilities: Array<Line<LiabilityGroup>> | null = null, equity: Array<Line<EquityGroup>> | null = null;
  if (totals.liabilities !== undefined) {
    liabilities = reconcile(liabilityRows, totals.liabilities);
    equity = reconcile(equityRows, totals.balancing - totals.liabilities);
  } else {
    const equityTotal = totals.equity ?? totals.parentEquity;
    const counted = equityRows.filter(r => r.group !== "redeemable" && (totals.equity !== undefined || r.group !== "noncontrolling"));
    if (equityTotal !== undefined && reconcile(counted, equityTotal)) {
      equity = reconcile(equityRows, totals.balancing - sum(liabilityRows));
      liabilities = equity && reconcile(liabilityRows, totals.balancing - sum(equity));
    } else issues.push("LIABILITY_EQUITY_BOUNDARY_UNVERIFIED");
  }
  if (!assets || !liabilities || !equity) {
    issues.push(`BALANCE_SHEET_UNRECONCILED:${[!assets && "assets", !liabilities && "liabilities", !equity && "equity"].filter(Boolean).join(",")}`);
    return null;
  }
  return {
    asOf, currency: [...read.currencies][0], assets: ids(assets), liabilities: ids(liabilities), equity: ids(equity),
    totals: { assets: String(totals.assets), liabilities: String(sum(liabilities)), equity: String(sum(equity)),
      currentAssets: totals.currentAssets === undefined ? null : String(totals.currentAssets),
      currentLiabilities: totals.currentLiabilities === undefined ? null : String(totals.currentLiabilities) },
    source,
  };
}

type CashSection = "operating" | "investing" | "financing";
const SECTION_ORDER: Array<"pre" | CashSection> = ["pre", "operating", "investing", "financing"];

export function extractCashFlow(statements: FinancialStatements, source: CapitalSource, issues: string[] = []): CashFlowStatement | null {
  const tables = statementTables(statements, "cashflow");
  if (!tables.length) { issues.push("CASH_FLOW_NOT_LOCATED"); return null; }
  const durations = tables.flatMap(t => t.rows.flatMap(r => r.cells.flatMap(c => c.facts))).filter(f => monetary(f) && f.period?.kind === "duration" && f.period.start && f.period.end);
  const end = durations.map(f => f.period!.end!).sort().at(-1);
  // The cumulative column: the longest period ending on the statement date, up to a fiscal year.
  const start = durations.filter(f => f.period!.end === end && days(f.period!.start!, end!) >= 70 && days(f.period!.start!, end!) <= 380).map(f => f.period!.start!).sort()[0];
  if (!end || !start) { issues.push("CASH_FLOW_UNTAGGED"); return null; }
  const read = rows(tables, f => f.period?.kind === "duration" && f.period.start === start && f.period.end === end);
  if (read.currencies.size !== 1) { issues.push("CASH_FLOW_CURRENCY_MIXED"); return null; }
  let section: (typeof SECTION_ORDER)[number] | "tail" | "supplemental" = "pre", workingCapital = false;
  const leaves: Record<CashSection, Row[]> = { operating: [], investing: [], financing: [] }, workingRows = new Set<Row>();
  const totals: Partial<Record<CashSection | "fx" | "net", number>> = {};
  const supplemental: Row[] = [];
  for (const row of read.rows) {
    const concept = local(row.concept), text = row.label;
    const heading = row.value === null && (["operating", "investing", "financing"] as const).find(s => new RegExp(`${s} activities`, "i").test(text));
    if (heading && section !== "tail" && section !== "supplemental" && SECTION_ORDER.indexOf(heading) > SECTION_ORDER.indexOf(section)) { section = heading; continue; }
    if (row.value === null) { if (section === "operating" && /changes in (?:operating )?(?:assets and liabilities|working capital)|working capital/i.test(text)) workingCapital = true; continue; }
    const totalOf = concept.match(/^NetCashProvidedByUsedIn(Operating|Investing|Financing)Activities$/)?.[1]?.toLowerCase() as CashSection | undefined
      ?? (/^net cash\b/i.test(text) && !/continuing|discontinued/i.test(text) ? (["operating", "investing", "financing"] as const).find(s => text.toLowerCase().includes(s)) : undefined);
    if (totalOf) { totals[totalOf] = row.value; if (totalOf === "financing") section = "tail"; continue; }
    if (/ContinuingOperations$/.test(concept) && /^NetCashProvidedByUsedIn/.test(concept)) continue;
    if (section === "tail" || section === "supplemental") {
      if (/^EffectOfExchangeRateOn/.test(concept) || /effect of (?:foreign )?(?:currency )?exchange rate/i.test(text)) { totals.fx = row.value; continue; }
      if (/PeriodIncreaseDecrease/.test(concept) || /^net (?:increase|decrease|change)/i.test(text)) { totals.net = row.value; section = "supplemental"; continue; }
      if (section === "supplemental" && !/^total\b/i.test(text)) supplemental.push(row);
      continue;
    }
    if (section === "pre" || /^total\b/i.test(text)) continue;
    leaves[section].push(row);
    if (section === "operating" && (workingCapital || /^IncreaseDecrease/.test(concept))) workingRows.add(row);
  }
  if (totals.operating === undefined || totals.investing === undefined || totals.financing === undefined) { issues.push("CASH_FLOW_TOTALS_MISSING"); return null; }
  const net = totals.net ?? totals.operating + totals.investing + totals.financing + (totals.fx ?? 0);
  if (!near(totals.operating + totals.investing + totals.financing + (totals.fx ?? 0), net)) { issues.push("CASH_FLOW_DOES_NOT_FOOT"); return null; }
  const operatingGroup = (row: Row): OperatingGroup => /Discontinued/.test(row.concept) ? "other"
    : /^(?:NetIncomeLoss|ProfitLoss|IncomeLossFromContinuingOperations|NetIncomeLossAttributableToParent)$/.test(local(row.concept)) || /^net (?:income|loss|earnings)/i.test(row.label) ? "netIncome"
    : workingRows.has(row) ? "workingCapital" : "nonCash";
  const sectionOf = <G extends string>(name: CashSection, group: (row: Row) => G): CashFlowSection<G> => {
    const lines = reconcile(leaves[name].map(r => ({ ...r, value: r.value!, group: group(r) })), totals[name]!);
    if (!lines) issues.push(`CASH_FLOW_${name.toUpperCase()}_LINES_UNRECONCILED`);
    return { total: String(totals[name]), lines: lines && ids(lines) };
  };
  return {
    periodStart: start, periodEnd: end, currency: [...read.currencies][0], basis: "reported",
    operating: sectionOf("operating", operatingGroup),
    investing: sectionOf("investing", r => classify(r, INVESTING_RULES, "other")),
    financing: sectionOf("financing", r => debtBySign(classify(r, FINANCING_RULES, "other"), r.value!)),
    fxEffect: totals.fx === undefined ? null : String(totals.fx), netChange: String(net),
    supplemental: ids(supplemental.slice(0, 30).map(r => ({ ...r, value: r.value!, group: classify(r, SUPPLEMENTAL_RULES, "other") }))),
    sources: [source],
  };
}

export function extractCapitalFiling(statements: FinancialStatements, source: CapitalSource): CapitalFiling {
  const issues: string[] = [];
  if (statements.status !== "extracted") return { version: CAPITAL_VERSION, source, balanceSheet: null, cashFlow: null, issues: ["FINANCIAL_STATEMENTS_NOT_LOCATED"] };
  const balanceSheet = extractBalanceSheet(statements, source, issues), cashFlow = extractCashFlow(statements, source, issues);
  return { version: CAPITAL_VERSION, source, balanceSheet, cashFlow, issues };
}

/**
 * A three-month cash flow. A cumulative statement is differenced with the adjacent filing's cumulative
 * statement from the same fiscal-year start. A row first presented in the later filing had no activity
 * earlier in the year and counts as zero there. A row that disappears, or changes group, means the
 * presentation changed; then only the section totals are derived.
 */
export function quarterCashFlow(current: CashFlowStatement, prior: CashFlowStatement | null): CashFlowStatement | null {
  const span = days(current.periodStart, current.periodEnd);
  if (span >= 70 && span <= 110) return current;
  if (!prior || prior.periodStart !== current.periodStart || prior.currency !== current.currency) return null;
  const gap = days(prior.periodEnd, current.periodEnd);
  if (gap < 70 || gap > 110) return null;
  const minus = (a: string | null, b: string | null) => String(Number(a ?? 0) - Number(b ?? 0));
  const lines = <G extends string>(a: CapitalLine<G>[] | null, b: CapitalLine<G>[] | null) => {
    if (!a || !b) return null;
    const currentIds = new Map(a.map(line => [line.id, line]));
    const debt = (group: string | undefined) => group === "debtIssued" || group === "debtRepaid";
    if (b.some(line => currentIds.get(line.id)?.group !== line.group && !(debt(line.group) && debt(currentIds.get(line.id)?.group)))) return null;
    const previous = new Map(b.map(line => [line.id, line.value]));
    return a.map(line => {
      const value = minus(line.value, previous.get(line.id) ?? null);
      return { ...line, value, group: debt(line.group) ? debtBySign(line.group as FinancingGroup, Number(value)) as G : line.group };
    }).filter(line => Number(line.value) !== 0);
  };
  const section = <G extends string>(a: CashFlowSection<G>, b: CashFlowSection<G>) => ({ total: minus(a.total, b.total), lines: lines(a.lines, b.lines) });
  const previousSupplemental = new Map(prior.supplemental.map(line => [line.id, line]));
  const sources = [...new Map([...current.sources, ...prior.sources].map(s => [s.accession, s])).values()];
  return {
    periodStart: nextDay(prior.periodEnd), periodEnd: current.periodEnd, currency: current.currency, basis: "derived",
    formula: `截至 ${current.periodEnd} 的年初至今累计 − 截至 ${prior.periodEnd} 的年初至今累计（财年起点 ${current.periodStart}；前期未列示的行按 0 计）`,
    operating: section(current.operating, prior.operating), investing: section(current.investing, prior.investing), financing: section(current.financing, prior.financing),
    fxEffect: current.fxEffect === null && prior.fxEffect === null ? null : minus(current.fxEffect, prior.fxEffect),
    netChange: minus(current.netChange, prior.netChange),
    supplemental: current.supplemental.filter(line => (previousSupplemental.get(line.id)?.group ?? line.group) === line.group)
      .map(line => ({ ...line, value: minus(line.value, previousSupplemental.get(line.id)?.value ?? null) })).filter(line => Number(line.value) !== 0),
    sources,
  };
}

const periodEndOf = (filing: CapitalFiling) => filing.cashFlow?.periodEnd ?? filing.balanceSheet?.asOf ?? null;

/** Newest quarters first. Per period, the latest filing with a reconciled statement wins (amendments supersede). */
export function buildCapitalQuarters(filings: CapitalFiling[], limit = 8): CapitalQuarter[] {
  const byEnd = new Map<string, CapitalFiling>();
  for (const filing of filings) {
    const end = periodEndOf(filing), old = end ? byEnd.get(end) : undefined;
    if (end && (!old || filing.source.filedAt > old.source.filedAt)) byEnd.set(end, filing);
  }
  const cumulative = [...byEnd.values()].map(f => f.cashFlow).filter((c): c is CashFlowStatement => c !== null);
  return [...byEnd.keys()].sort().reverse().slice(0, limit).map(periodEnd => {
    const filing = byEnd.get(periodEnd)!, yearToDate = filing.cashFlow;
    const prior = yearToDate && cumulative.find(c => c.periodStart === yearToDate.periodStart && c.periodEnd < yearToDate.periodEnd && days(c.periodEnd, yearToDate.periodEnd) >= 70 && days(c.periodEnd, yearToDate.periodEnd) <= 110);
    return { periodEnd, balanceSheet: filing.balanceSheet, cashFlow: yearToDate && quarterCashFlow(yearToDate, prior ?? null), yearToDate };
  });
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amount = z.string().refine(v => v.trim() !== "" && Number.isFinite(Number(v)));
const secUrl = z.string().refine(v => { try { const u = new URL(v); return u.protocol === "https:" && /(^|\.)sec\.gov$/.test(u.hostname); } catch { return false; } });
const sourceSchema = z.object({ accession: z.string().regex(/^\d{10}-\d{2}-\d{6}$/), url: secUrl, filedAt: z.string().max(40), form: z.string().max(12) });
const lineSchema = <G extends readonly [string, ...string[]]>(groups: G) => z.object({ id: z.string().min(1).max(200), label: z.string().max(400), concept: z.string().max(300), group: z.enum(groups), value: amount });
const sectionSchema = <G extends readonly [string, ...string[]]>(groups: G) => z.object({ total: amount, lines: z.array(lineSchema(groups)).max(80).nullable() });
const balanceSchema = z.object({
  asOf: date, currency: z.string().regex(/^[A-Z]{3}$/),
  assets: z.array(lineSchema(["cash", "receivables", "inventory", "productive", "leaseAssets", "intangibles", "investments", "other"] as const)).max(80),
  liabilities: z.array(lineSchema(["debt", "leases", "customerAdvances", "payables", "deferredTax", "other"] as const)).max(80),
  equity: z.array(lineSchema(["paidIn", "retained", "otherEquity", "noncontrolling", "redeemable"] as const)).max(40),
  totals: z.object({ assets: amount, liabilities: amount, equity: amount, currentAssets: amount.nullable(), currentLiabilities: amount.nullable() }),
  source: sourceSchema,
});
const cashFlowSchema = z.object({
  periodStart: date, periodEnd: date, currency: z.string().regex(/^[A-Z]{3}$/), basis: z.enum(["reported", "derived"]), formula: z.string().max(300).optional(),
  operating: sectionSchema(["netIncome", "nonCash", "workingCapital", "other"] as const),
  investing: sectionSchema(["capex", "acquisitions", "investments", "other"] as const),
  financing: sectionSchema(["debtIssued", "debtRepaid", "equityIssued", "buybacks", "dividends", "leasePrincipal", "other"] as const),
  fxEffect: amount.nullable(), netChange: amount,
  supplemental: z.array(lineSchema(["interestPaid", "taxesPaid", "unpaidCapex", "leaseAssetsObtained", "other"] as const)).max(30),
  sources: z.array(sourceSchema).min(1).max(4),
});
const total = (lines: Array<{ value: string }>) => lines.reduce((s, l) => s + Number(l.value), 0);

/** Re-checks every identity the extractor promised; a statement that fails is dropped, never repaired. */
function validBalance(raw: unknown): BalanceSheet | null {
  const parsed = balanceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const b = parsed.data, t = b.totals;
  const ok = near(total(b.assets), Number(t.assets)) && near(total(b.liabilities), Number(t.liabilities)) && near(total(b.equity), Number(t.equity))
    && near(Number(t.liabilities) + Number(t.equity), Number(t.assets));
  return ok ? b : null;
}
function validCashFlow(raw: unknown): CashFlowStatement | null {
  const parsed = cashFlowSchema.safeParse(raw);
  if (!parsed.success) return null;
  const c = parsed.data, sections = [c.operating, c.investing, c.financing];
  const ok = days(c.periodStart, c.periodEnd) >= 70 && days(c.periodStart, c.periodEnd) <= 380
    && sections.every(s => !s.lines || near(total(s.lines), Number(s.total)))
    && near(sections.reduce((s, x) => s + Number(x.total), 0) + Number(c.fxEffect ?? 0), Number(c.netChange));
  return ok ? c : null;
}

export function readCapitalStructure(raw: unknown, ticker: string): PublicCapitalStructure | null {
  const parsed = z.object({ schemaVersion: z.literal("capital-structure.v1"), ticker: z.literal(ticker), quarters: z.array(z.unknown()).max(12) }).safeParse(raw);
  if (!parsed.success) return null;
  const seen = new Set<string>(), quarters: CapitalQuarter[] = [];
  for (const item of parsed.data.quarters) {
    const q = z.object({ periodEnd: date, balanceSheet: z.unknown(), cashFlow: z.unknown(), yearToDate: z.unknown() }).safeParse(item);
    if (!q.success || seen.has(q.data.periodEnd)) continue;
    const quarter = { periodEnd: q.data.periodEnd, balanceSheet: validBalance(q.data.balanceSheet), cashFlow: validCashFlow(q.data.cashFlow), yearToDate: validCashFlow(q.data.yearToDate) };
    if (quarter.balanceSheet && quarter.balanceSheet.asOf !== quarter.periodEnd) quarter.balanceSheet = null;
    if (quarter.cashFlow && (quarter.cashFlow.periodEnd !== quarter.periodEnd || days(quarter.cashFlow.periodStart, quarter.cashFlow.periodEnd) > 110)) quarter.cashFlow = null;
    if (quarter.yearToDate?.periodEnd !== quarter.periodEnd) quarter.yearToDate = null;
    if (!quarter.balanceSheet && !quarter.cashFlow && !quarter.yearToDate) continue;
    seen.add(quarter.periodEnd);
    quarters.push(quarter);
  }
  quarters.sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  return quarters.length ? { schemaVersion: "capital-structure.v1", ticker, quarters } : null;
}
