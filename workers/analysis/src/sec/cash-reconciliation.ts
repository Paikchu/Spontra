/** Conservative table reconciliation. Unknown layouts stay unknown rather than guessing a column. */
export function reconcileCapitalOutlay(sources: Array<{ evidenceId: string; text: string; truncated?: boolean }>, grossCapex: number, currency: string) {
  const results: Array<{ netCapex: number; adjustments: Array<{ label: string; value: number }>; evidenceId: string }> = [];
  for (const source of sources) {
    if (source.truncated || currency !== "USD" || !/\(\$ in millions\)/i.test(source.text)) continue;
    const lines = source.text.split(/\n/).map(s => s.trim()).filter(Boolean);
    const start = lines.findIndex(s => /^capital expenditures(?:\s*\(\d+\))?$/i.test(s));
    const end = lines.findIndex((s, i) => i > start && /^net (?:cash outlay for )?capital expenditures(?:\s*\(\d+\))?$/i.test(s));
    if (start < 0 || end <= start) continue;
    const rows: Array<{ label: string; values: number[] }> = [];
    for (let i = start; i <= end;) {
      const label = lines[i++];
      let values = "";
      while (i < lines.length && /^(?:\$|[\d,().\-−—]+)$/.test(lines[i])) values += " " + lines[i++];
      const numbers = values.replace(/\$\s*/g, "").match(/\(\s*[\d,.]+\s*\)|[−-]?[\d,]+(?:\.\d+)?|—/g) ?? [];
      rows.push({ label, values: numbers.map(s => s === "—" ? 0 : Number(s.replace(/[(),\s]/g, "").replace("−", "-")) * (s.includes("(") ? -1 : 1) * 1e6) });
      if (rows.at(-1)!.label === lines[end]) break;
      if (i > end) break;
    }
    if (rows.length < 3 || rows.at(-1)?.label !== lines[end] || rows.some(r => r.values.length !== rows[0].values.length)) continue;
    const columns = rows[0].values.flatMap((v, i) => Math.abs(v - grossCapex) < 1 ? [i] : []);
    for (const column of columns) {
      const adjustments = rows.slice(1, -1).map(r => ({ label: r.label, value: r.values[column] }));
      const netCapex = rows.at(-1)!.values[column];
      if (netCapex < 0 || Math.abs(grossCapex + adjustments.reduce((sum, a) => sum + a.value, 0) - netCapex) > 1) continue;
      results.push({ netCapex, adjustments, evidenceId: source.evidenceId });
    }
    // Repeated totals are acceptable only when every matching column has the same reconciliation.
    if (columns.length && results.filter(r => r.evidenceId === source.evidenceId).length !== columns.length) return;
  }
  if (!results.length || results.some(r => JSON.stringify([r.netCapex, r.adjustments]) !== JSON.stringify([results[0].netCapex, results[0].adjustments]))) return;
  return results[0];
}
