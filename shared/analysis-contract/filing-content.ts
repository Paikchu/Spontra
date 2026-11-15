export type FilingTableCell = { text: string; value: number | null };
export type FilingTableRow = { label: string; path: string[]; cells: FilingTableCell[] };
export type FilingTable = { rowHeader?: string; unit: string | null; columns: string[]; rows: FilingTableRow[]; notes: string[]; xbrlBlock: string | null };

export type FilingFactRow = {
  factId: string; passageId: string; ordinal: number;
  /** The cell in the material's table; null for a number inside a paragraph. */
  row: number | null; col: number | null;
  label: string; concept: string | null;
  /** "Axis=Member;…" in axis order; empty for the company as a whole. */
  dimensions: string;
  periodStart: string | null; periodEnd: string | null;
  /** 0 for a balance at a date, the months covered for a flow, null when the table does not say. */
  periodMonths: number | null;
  /** The number in base units (dollars, shares, a percentage as written). */
  value: number;
  /** The number as the filing prints it. */
  shown: string;
  unit: string;
  tagged: boolean;
};
