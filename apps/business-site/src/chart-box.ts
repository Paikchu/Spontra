/** The chart pane measured on the page that is about to leave, so the next chart's first paint is already fitted. */
export type ChartBox = { w: number; h: number };

let staged: ChartBox | null = null;

/** Round the way the Sankey does, so the fitted drawing does not jump a frame later. */
export function stageChartBox() {
  const el = document.querySelector(".chart");
  if (!el) return;
  const w = Math.round(el.clientWidth / 8) * 8;
  const h = Math.round(el.clientHeight / 8) * 8;
  if (w > 0 && h > 0) staged = { w, h };
}

export function peekChartBox(): ChartBox | null {
  return staged;
}
