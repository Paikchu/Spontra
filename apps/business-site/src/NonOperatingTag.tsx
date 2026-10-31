import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/packages/web/src/ui/button";
import { getLocale, labels, messages } from "@/packages/web/src/i18n";
import { compactMoney } from "@/shared/analysis-runtime/locale";
import type { NonOperating, NonOperatingLine } from "./non-operating";

const LINE = labels<Exclude<NonOperatingLine["kind"], "statement">>(
  { equity_securities: "Gains on equity securities (fair value)", interest_income: "Interest income", interest_expense: "Interest expense", foreign_exchange: "Foreign exchange", other: "Other non-operating items", tax: "Income taxes" },
  { equity_securities: "投资公允价值变动", interest_income: "利息收入", interest_expense: "利息支出", foreign_exchange: "汇兑损益", other: "其他营业外项目", tax: "所得税" });
const m = messages({
  tag: (gain: boolean, amount: string) => `Non-operating ${gain ? "gain" : "loss"} ${amount}`,
  title: (gain: boolean, amount: string) => `Net income includes a non-operating ${gain ? "gain" : "loss"} of ${amount}`,
  gap: (net: string, operating: string, share: string) => `Net income ${net} against operating income ${operating}, ${share} of it apart.`,
  composition: "What sits between them",
  adjusted: (amount: string) => `Excluding it, about ${amount}`,
  adjustedWhy: (rate: string | null) => rate ? `Net income less the non-operating total after tax at this quarter's effective rate (${rate}).` : "Net income less the non-operating total; no tax rate could be read.",
  source: "SEC filing", trend: "Compare the trends",
}, {
  tag: (gain: boolean, amount: string) => `含非经营${gain ? "收益" : "损失"} ${amount}`,
  title: (gain: boolean, amount: string) => `净利润含非经营${gain ? "收益" : "损失"} ${amount}`,
  gap: (net: string, operating: string, share: string) => `净利润 ${net}，营业利润 ${operating}，两者相差营业利润的 ${share}。`,
  composition: "两者之间的构成",
  adjusted: (amount: string) => `扣除后约 ${amount}`,
  adjustedWhy: (rate: string | null) => rate ? `净利润减去按本季有效税率（${rate}）税后的非经营合计。` : "净利润减去非经营合计；读不到税率，未计税。",
  source: "SEC 原文", trend: "对比走势",
});

const pct = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;

/**
 * The tag beside net income when non-operating lines set it far from operating income (R28): green for a gain, amber
 * for a loss. Pressing it opens the composition the filings tag, net income without it, the filing and a button that
 * puts the operating and net income trends on the chart.
 */
export function NonOperatingTag({ result, onTrend, size = "small" }: { result: NonOperating; onTrend?: () => void; size?: "regular" | "small" }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<CSSProperties | null>(null);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null), pop = useRef<HTMLSpanElement>(null);
  // The hero row clips and scrolls sideways, so the card is laid on the page under the tag and kept inside the window.
  useLayoutEffect(() => {
    if (!open) { setAt(null); return; }
    const tag = root.current?.getBoundingClientRect(), card = pop.current?.getBoundingClientRect();
    if (!tag || !card) return;
    const left = Math.max(12, Math.min(tag.left, innerWidth - card.width - 12));
    const below = tag.bottom + 6 + card.height <= innerHeight - 12 || tag.top - 6 - card.height < 12;
    setAt({ left, top: below ? tag.bottom + 6 : tag.top - 6 - card.height });
    // The card lives at the end of the page; focus moves into it so its link and button come next on Tab.
    pop.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node) && !pop.current?.contains(e.target as Node)) setOpen(false); };
    const close = () => setOpen(false);
    addEventListener("pointerdown", away);
    addEventListener("resize", close);
    addEventListener("scroll", close, true);
    return () => { removeEventListener("pointerdown", away); removeEventListener("resize", close); removeEventListener("scroll", close, true); };
  }, [open]);
  const locale = getLocale();
  const money = (v: number) => compactMoney(v, result.currency, locale);
  const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${money(Math.abs(v))}`;
  const gain = result.kind === "gain";
  return <span className="nonop" ref={root} data-kind={result.kind} data-size={size} data-open={open || undefined}>
    <Button variant="unstyled" type="button" className="nonop-tag" aria-expanded={open} aria-controls={id}
      onClick={e => { e.stopPropagation(); e.preventDefault(); setOpen(v => !v); }} onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}>
      {m.tag(gain, money(result.amount))}
    </Button>
    {open && createPortal(<span className="nonop-pop" ref={pop} data-kind={result.kind} style={at ?? { left: 0, top: 0, visibility: "hidden" }} id={id} role="dialog" aria-label={m.title(gain, money(result.amount))} lang={locale} tabIndex={-1}
      onKeyDown={e => { if (e.key === "Escape") { setOpen(false); root.current?.querySelector("button")?.focus(); } }}>
      <b>{m.title(gain, money(result.amount))}</b>
      <small>{m.gap(money(result.net), money(result.operating), pct(Math.abs(result.net - result.operating) / Math.abs(result.operating)))}</small>
      <span className="nonop-head">{m.composition}</span>
      <ol>{result.lines.map((line, i) => <li key={i} data-kind={line.kind}><span>{line.kind === "statement" ? line.name : LINE[line.kind]}</span><em data-trend={line.value >= 0 ? "up" : "down"}>{signed(line.value)}</em></li>)}</ol>
      <span className="nonop-adjusted"><span>{m.adjusted(money(result.adjusted))}</span><small>{m.adjustedWhy(result.taxRate == null ? null : pct(result.taxRate))}</small></span>
      <span className="nonop-actions">
        {result.sourceUrl && <a href={result.sourceUrl} target="_blank" rel="noopener noreferrer">{m.source}<span aria-hidden="true"> ↗</span></a>}
        {onTrend && <Button variant="unstyled" type="button" className="nonop-trend" onClick={() => { setOpen(false); onTrend(); }}>{m.trend}</Button>}
      </span>
    </span>, document.body)}
  </span>;
}
