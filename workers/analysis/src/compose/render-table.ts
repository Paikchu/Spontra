import type { FindingPassage } from "../../../../shared/analysis-contract/findings.ts";

const TABLE_CHARS = 5000;

/**
 * A filing table as the model reads it: every row carries its index so a {passageCell} can name it, and the focus
 * terms select rows by label (the header and the matching rows, in full) so a long statement is never cut off before
 * the line the question is about. Without a match the whole table is shown up to the character budget.
 */
export function renderTable(table: NonNullable<FindingPassage["table"]>, focus: string[]): string {
  const terms = focus.map(f => f.toLowerCase()).filter(Boolean);
  const matches = terms.length ? table.rows.map((r, i) => ({ r, i })).filter(({ r }) => { const label = r.label.toLowerCase(); return terms.some(t => label.includes(t)); }) : [];
  const shown = matches.length ? matches : table.rows.map((r, i) => ({ r, i }));
  const head = `table unit ${table.unit ?? "none"}; columns: ${table.columns.map((c, i) => `${i}:${c || "(blank)"}`).join(", ")}; ${table.rows.length} rows${matches.length ? `, ${matches.length} matching focus` : ""}`;
  const body: string[] = [];
  let used = head.length;
  for (const { r, i } of shown) {
    const line = `row ${i}: ${r.label} | ${r.cells.map(c => c.text || "—").join(" | ")}`;
    if (used + line.length > TABLE_CHARS) { body.push(`(${shown.length - body.length} more rows; narrow with focus)`); break; }
    body.push(line); used += line.length + 1;
  }
  const rest = matches.length && matches.length < table.rows.length ? `\nother rows: ${table.rows.map((r, i) => `${i}:${r.label}`).filter((_, i) => !matches.some(m => m.i === i)).join(", ").slice(0, 1200)}` : "";
  return `${head}\n${body.join("\n")}${rest}`;
}
