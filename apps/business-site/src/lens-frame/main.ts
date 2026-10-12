import type { CompiledChart, LensFrameMessage, LensFrameSize, LensFrameTheme } from "@/shared/analysis-contract/lens-frame";
import { renderChartSvg } from "@/shared/analysis-runtime/lens/render";
import { applyHover, watchHover } from "./hover";
import "./frame.css";

/**
 * The chart frame: a sandboxed page that only paints what the host hands it. It holds no data of its
 * own, fetches nothing, and speaks to its parent alone, through the lens-frame messages.
 */
const state: { id: string | null; chart: CompiledChart | null; size: LensFrameSize | null; unwatch: (() => void) | null; drawn: string | null } = { id: null, chart: null, size: null, unwatch: null, drawn: null };
/** The frame shares the page's origin (same-origin sandbox), so messages go to that origin alone. */
const post = (message: LensFrameMessage) => window.parent.postMessage(message, location.origin);

function applyTheme(theme: LensFrameTheme) {
  const root = document.documentElement;
  for (const [token, value] of Object.entries(theme.tokens)) root.style.setProperty(token, value);
  root.style.colorScheme = theme.scheme;
  root.classList.toggle("light", theme.scheme === "light");
}

function draw() {
  if (!state.chart || !state.size || !state.id) return;
  state.unwatch?.();
  // A chart already on screen redraws at its new size without replaying its entrance.
  document.body.innerHTML = renderChartSvg(state.chart, state.size, { still: state.drawn === state.id });
  state.drawn = state.id;
  const svg = document.body.querySelector<SVGElement>("svg");
  if (svg) state.unwatch = watchHover(svg, period => { applyHover(svg, period); post({ type: "lens:hover", id: state.id!, period }); });
  post({ type: "lens:rendered", id: state.id });
}

window.addEventListener("message", (event: MessageEvent<LensFrameMessage>) => {
  if (event.source !== window.parent || event.origin !== location.origin || !event.data || typeof event.data !== "object") return;
  const message = event.data;
  switch (message.type) {
    case "lens:render": applyTheme(message.theme); state.id = message.id; state.chart = message.chart; state.size = message.size; draw(); break;
    case "lens:size": if (message.id === state.id) { state.size = message.size; draw(); } break;
    case "lens:theme": applyTheme(message.theme); break;
    case "lens:focus": { const svg = document.body.querySelector<SVGElement>("svg"); if (svg && message.id === state.id) applyHover(svg, message.period); break; }
    default: break;
  }
});
/** The frame's state is visible from the parent's devtools, since the frame has no UI of its own to show it. */
(window as unknown as { __lens: typeof state }).__lens = state;
post({ type: "lens:ready" });
