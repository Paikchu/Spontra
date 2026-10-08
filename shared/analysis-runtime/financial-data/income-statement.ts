import type { FinancialStatements, StatementCell, StatementTable } from "./financial-statements.ts";

/**
 * Income statement rows down to operating income, read from the filing's own statement table.
 * Labels, order and concepts are the issuer's presentation; each amount is the XBRL fact tagged in the
 * printed cell, with whether the statement prints it with the opposite sign of the fact.
 */
type Fact = StatementCell["facts"][number];
export interface IncomeStatementCell { order: number; label: string; factId: string; concept: string; start: string; end: string; flip: boolean }

const local = (concept: string) => concept.split(":").at(-1)!;
const amountFact = (fact: Fact) => fact.status === "parsed" && fact.value !== null && /^-?\d+(?:\.\d+)?$/.test(fact.value)
  && /^iso4217:[A-Z]{3}$/.test(fact.unit ?? "") && fact.period?.kind === "duration" && !!fact.period.start && !!fact.period.end;
const operatingIncome = (fact: Fact) => amountFact(fact) && !fact.dimensions.length && local(fact.concept) === "OperatingIncomeLoss";
const decoration = /^(?:[$€£¥()%]|US\$|\)|—|–|-)?$/;
const labelCell = (row: StatementTable["rows"][number]) => row.cells.find(c => c.text.trim() && !decoration.test(c.text.trim()) && !/^\(?[\d,.\s]+\)?$/.test(c.text.trim()));
const cleanLabel = (text: string) => text.replace(/\s*\((?:\d{1,2}|[a-z])\)\s*$/i, "").replace(/[:：]\s*$/, "").trim();

/** The primary statement is the first non-note table that reports consolidated operating income. */
function incomeStatement(statements: FinancialStatements): StatementTable | undefined {
  return statements.tables.find(table => !/^(?:notes?\b|\d{1,2}[.\s:–—-]+\D)/i.test(table.section.trim()) && !/parenthetical/i.test(table.section)
    && table.rows.some(row => row.cells.some(cell => cell.facts.some(operatingIncome))));
}

export function readIncomeStatementCells(statements: FinancialStatements): IncomeStatementCell[] {
  if (statements.status !== "extracted") return [];
  const table = incomeStatement(statements);
  if (!table) return [];
  const result: IncomeStatementCell[] = [];
  for (const [order, row] of table.rows.entries()) {
    const caption = labelCell(row), label = cleanLabel(caption?.text ?? ""), periods = new Set<string>();
    // Amounts quoted inside the caption describe the row; they are not its amount.
    for (const cell of row.cells) {
      if (cell === caption) continue;
      // Some issuers tag a face-statement line with a member, so a dimensional fact is used when it is the only one printed.
      const candidates = cell.facts.filter(amountFact), fact = candidates.find(f => !f.dimensions.length) ?? candidates[0];
      if (!fact) continue;
      const period = fact.period!.start + "|" + fact.period!.end;
      if (periods.has(period)) continue;
      periods.add(period);
      const next = row.cells.find(c => c.column === cell.column + cell.colSpan);
      const negative = cell.text.includes("(") || /^\)/.test(next?.text.trim() ?? "") || /^[-−–]\s*[$\d]/.test(cell.text.trim());
      const value = Number(fact.value);
      result.push({ order, label, factId: fact.id, concept: fact.concept, start: fact.period!.start!, end: fact.period!.end!, flip: value !== 0 && negative !== value < 0 });
    }
    if (row.cells.some(cell => cell.facts.some(operatingIncome))) break;
  }
  return result;
}
