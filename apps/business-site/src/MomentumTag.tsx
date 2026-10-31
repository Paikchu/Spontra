import { useId, useState } from "react";
import { Button } from "@/packages/web/src/ui/button";
import { getLocale, labels, messages } from "@/packages/web/src/i18n";
import { shortPeriod } from "@/shared/analysis-runtime/locale";
import type { Momentum, MomentumKind } from "./momentum";

const KIND = labels<MomentumKind>({ accelerating: "Accelerating", slowing: "Slowing", turnedNegative: "Turned negative" }, { accelerating: "加速", slowing: "放缓", turnedNegative: "转负" });
const WHY = labels<MomentumKind>({ accelerating: "YoY growth rose two quarters running", slowing: "YoY growth fell two quarters running", turnedNegative: "YoY growth turned from positive to negative" },
  { accelerating: "同比增速连续 2 季上升", slowing: "同比增速连续 2 季下降", turnedNegative: "同比增速由正转负" });
const m = messages({
  title: (subject: string) => `${subject} · YoY growth by quarter`, gap: "n/a",
}, {
  title: (subject: string) => `${subject} · 每季同比`, gap: "无",
});

const rate = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%`;

/**
 * A growth-momentum tag: green accelerating, amber slowing, red turned negative. Hovering, focusing or pressing it opens
 * the year-over-year growth of each quarter it read. `size="small"` is the hero tile's and the home card's.
 */
export function MomentumTag({ momentum, subject, size = "regular" }: { momentum: Momentum | null; subject: string; size?: "regular" | "small" }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!momentum) return null;
  const summary = `${subject} ${KIND[momentum.kind]} · ${WHY[momentum.kind]} · ${momentum.points.map(p => `${shortPeriod(p.periodEnd)} ${p.yoy == null ? m.gap : rate(p.yoy)}`).join(", ")}`;
  return <span className="momentum" data-kind={momentum.kind} data-size={size} data-open={open || undefined} onMouseLeave={() => setOpen(false)}>
    <Button variant="unstyled" type="button" className="momentum-tag" aria-expanded={open} aria-controls={id} aria-label={summary}
      onClick={e => { e.stopPropagation(); e.preventDefault(); setOpen(v => !v); }} onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}>
      <svg viewBox="0 0 12 12" aria-hidden="true">{momentum.kind === "accelerating" ? <path d="M2 9.5 6 5.5l1.8 1.8L10 3M7 3h3v3" /> : momentum.kind === "slowing" ? <path d="M2 3.5 6 6.5l1.8-1.3L10 9M7 9h3V6" /> : <path d="M2 4h4l4 4.5M7.5 8.5H10V6" />}</svg>
      {KIND[momentum.kind]}
    </Button>
    <span className="momentum-pop" id={id} role="tooltip" lang={getLocale()}>
      <b>{m.title(subject)}</b>
      <small>{WHY[momentum.kind]}</small>
      <ol>{momentum.points.map(p => <li key={p.periodEnd}><span>{shortPeriod(p.periodEnd)}</span><em data-trend={p.yoy == null ? undefined : p.yoy >= 0 ? "up" : "down"}>{p.yoy == null ? m.gap : rate(p.yoy)}</em></li>)}</ol>
    </span>
  </span>;
}
