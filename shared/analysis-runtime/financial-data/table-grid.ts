import { descendants, nodeText, type Element } from './disclosure-extraction.ts';

export interface GridCell { column: number; rowSpan: number; colSpan: number; header: boolean; text: string; node: Element }
export interface TableGrid { rows: { cells: GridCell[] }[]; columns: number; issues: string[] }

const ancestor = (n: Element, tag: string): Element | null => { for (let p = n.parent; p; p = p.parent) if (p.local === tag) return p; return null; };

/**
 * The cells of one HTML table, each placed in the column it occupies once earlier row spans are counted.
 * Shared by the financial statements extractor and the filing library so both read a table the same way.
 */
export function tableGrid(table: Element): TableGrid {
  const rows = descendants(table).filter(n => n.local === 'tr' && ancestor(n, 'table') === table);
  const occupied = new Map<number, number>(), issues: string[] = [];
  let columns = 0;
  const result = rows.map((row, r) => {
    let column = 0;
    return {
      cells: descendants(row).filter(n => ['td', 'th'].includes(n.local) && ancestor(n, 'tr') === row && ancestor(n, 'table') === table).map(cell => {
        while ((occupied.get(column) ?? 0) > r) column++;
        const span = (name: string) => { const raw = cell.attributes[name]; if (!raw) return 1; const v = Number(raw); if (!Number.isSafeInteger(v) || v < 1 || v > 1000) { issues.push(`INVALID_${name.toUpperCase()}:${cell.start}`); return 1; } return v; };
        const colSpan = span('colspan'), rowSpan = span('rowspan'), at = column;
        for (let c = at; c < at + colSpan; c++) occupied.set(c, r + rowSpan);
        column += colSpan; columns = Math.max(columns, column);
        return { column: at, colSpan, rowSpan, header: cell.local === 'th', text: nodeText(cell, { blocks: true, documentTextMode: true }).replace(/\s+/g, ' ').trim(), node: cell };
      }),
    };
  });
  if (!table.closed) issues.push('UNCLOSED_TABLE');
  return { rows: result, columns, issues };
}
