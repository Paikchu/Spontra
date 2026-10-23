import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LENS_ASPECT } from "@/shared/analysis-contract/lens";
import { LENS_FRAME_TOKENS, type CompiledChart, type LensFrameMessage, type LensFrameSize, type LensFrameTheme } from "@/shared/analysis-contract/lens-frame";
import { renderChartSvg } from "@/shared/analysis-runtime/lens/render";
import { useLocale } from "@/packages/web/src/i18n";
import { applyHover, watchHover } from "./lens-frame/hover";

/** How long the frame may take to say it is ready before the chart is drawn in place instead. */
const FRAME_PATIENCE_MS = 1500;

/** The page's design tokens as the frame must mirror them, read from the root at the moment of use. */
function readTheme(): LensFrameTheme {
  const style = getComputedStyle(document.documentElement);
  return { scheme: document.documentElement.classList.contains("light") ? "light" : "dark", tokens: Object.fromEntries(LENS_FRAME_TOKENS.map(t => [t, style.getPropertyValue(t).trim()])) };
}
export function useTheme(): LensFrameTheme {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * One chart of a lens document. The cell's size comes from the page's CSS (the chart's aspect over the
 * cell's width); the frame paints to exactly that size and never reports a height of its own, so the
 * document's layout is the page's. When the frame is slow or blocked, the same renderer draws in place.
 */
export function LensFrame({ chart, onHover }: { chart: CompiledChart; onHover?: (period: number | null) => void }) {
  const locale = useLocale();
  const box = useRef<HTMLDivElement>(null), frame = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState<LensFrameSize | null>(null);
  const [ready, setReady] = useState(false), [rendered, setRendered] = useState(false), [fallback, setFallback] = useState(false);
  const theme = useTheme();
  // The cell is measured when it mounts and whenever its box changes; the frame only ever draws at the size the page gave it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setSize(s => s && s.width === Math.round(r.width) && s.height === Math.round(r.height) ? s : { width: Math.round(r.width), height: Math.round(r.height) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    addEventListener("resize", measure);
    return () => { observer.disconnect(); removeEventListener("resize", measure); };
  }, []);
  useEffect(() => {
    const listener = (event: MessageEvent<LensFrameMessage>) => {
      if (!frame.current || event.source !== frame.current.contentWindow || event.origin !== location.origin || !event.data || typeof event.data !== "object") return;
      const message = event.data;
      // The frame says ready once its script runs; the load event says the same and cannot be missed by a listener attached late.
      if (message.type === "lens:ready") setReady(true);
      else if (message.type === "lens:rendered" && message.id === chart.id) setRendered(true);
      else if (message.type === "lens:hover" && message.id === chart.id) onHover?.(message.period);
    };
    addEventListener("message", listener);
    return () => removeEventListener("message", listener);
  }, [chart.id, onHover]);
  useEffect(() => {
    if (ready || fallback) return;
    const timer = setTimeout(() => setFallback(true), FRAME_PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [ready, fallback]);
  const post = (message: LensFrameMessage) => frame.current?.contentWindow?.postMessage(message, location.origin);
  useEffect(() => { if (ready && size && !fallback) post({ type: "lens:render", id: chart.id, chart, size, theme }); }, [ready, size, chart, fallback]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (ready && !fallback) post({ type: "lens:theme", theme }); }, [theme]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={box} className="lens-chart-cell" style={{ "--aspect": LENS_ASPECT[chart.aspect] } as React.CSSProperties} data-ready={rendered || fallback ? "" : undefined}
    data-frame={fallback ? "inline" : rendered ? "rendered" : ready ? "ready" : "loading"} data-size={size ? `${size.width}x${size.height}` : undefined}>
    {fallback ? size && <InlineChart chart={chart} size={size} onHover={onHover} /> : <iframe ref={frame} src={`/lens-frame?lang=${locale}`} sandbox="allow-scripts allow-same-origin" title={chart.title ?? chart.summary} onLoad={() => setReady(true)} />}
    <p className="sr-only">{chart.summary}</p>
  </div>;
}

/** The same picture drawn into the page, for when the frame is not available. */
function InlineChart({ chart, size, onHover }: { chart: CompiledChart; size: LensFrameSize; onHover?: (period: number | null) => void }) {
  const locale = useLocale();
  const host = useRef<HTMLDivElement>(null);
  const drawn = useRef<string | null>(null);
  const html = useMemo(() => renderChartSvg(chart, size, { locale }), [chart, size, locale]);
  // A redraw of the same chart at a new size keeps still, before the first paint, so resizing does not replay the entrance.
  useLayoutEffect(() => {
    const svg = host.current?.querySelector<SVGElement>("svg");
    if (svg && drawn.current === chart.id) svg.setAttribute("data-still", "");
    drawn.current = chart.id;
  }, [html, chart.id]);
  useEffect(() => {
    const svg = host.current?.querySelector<SVGElement>("svg");
    if (!svg) return;
    return watchHover(svg, period => { applyHover(svg, period); onHover?.(period); });
  }, [html, onHover]);
  return <div ref={host} className="lens-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}
