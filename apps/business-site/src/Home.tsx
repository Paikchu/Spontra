import React, { useEffect, useRef, useState } from "react";
import { CompanyLogo } from "./CompanyMark";
import { SearchPanel } from "./SearchDialog";
import { ThemeToggle } from "./Sidebar";
import { loadDigest, type CompanyDigest } from "./company-data";
import { KIND_LABEL, type VerifiedFinding } from "./findings-model";

/** Companies the pipeline writes findings for (its SEC_AI_TICKERS); recently opened companies join them. */
const FINDINGS_TICKERS = ["ORCL", "ADSK", "NET"];
/** Each company costs four reads against a 60-per-minute public limit. */
const MAX_COMPANIES = 12;

const report = (periodEnd: string) => `${periodEnd.slice(0, 7).replace("-", ".")} 财报`;

/** Newest report first; within a report, the company with the most severe finding. */
function byReport(a: CompanyDigest, b: CompanyDigest) {
  return b.periodEnd.localeCompare(a.periodEnd) || b.findings[0].severity - a.findings[0].severity || a.ticker.localeCompare(b.ticker);
}

/** Verified once per page load: returning home shows the same digests without reading every statement again. */
const digestCache = new Map<string, Promise<CompanyDigest | null>>();
function digestOf(ticker: string) {
  let digest = digestCache.get(ticker);
  if (!digest) {
    digest = loadDigest(ticker, new AbortController().signal).catch(() => null);
    digestCache.set(ticker, digest);
    // Only a complete answer is kept; an empty or fallback one is read again next time home opens.
    void digest.then(d => { if (!d || d.partial) digestCache.delete(ticker); });
  }
  return digest;
}

/** The companies are fixed for the life of the page; the home page remounts after visiting one. */
function useDigests(tickers: string[]) {
  const [list] = useState(tickers);
  const [digests, setDigests] = useState<CompanyDigest[]>([]);
  const [pending, setPending] = useState(list.length);
  useEffect(() => {
    let live = true;
    for (const ticker of list)
      void digestOf(ticker).then(digest => {
        if (!live) return;
        if (digest) setDigests(all => [...all.filter(d => d.ticker !== ticker), digest].sort(byReport));
        setPending(n => n - 1);
      });
    return () => { live = false; };
  }, [list]);
  return { digests, loading: pending > 0 };
}

type Item = { ticker: string; periodEnd: string; finding: VerifiedFinding };

/** Companies take turns, each in its own severity order, so no row is one company's list. */
function interleave(digests: CompanyDigest[]): Item[] {
  const items: Item[] = [];
  const longest = Math.max(0, ...digests.map(d => d.findings.length));
  for (let i = 0; i < longest; i++)
    for (const d of digests) if (d.findings[i]) items.push({ ticker: d.ticker, periodEnd: d.periodEnd, finding: d.findings[i] });
  return items;
}

/** Two rows, dealt alternately so neighbouring chips differ between them. */
function rows(items: Item[]): Item[][] {
  const count = Math.min(2, items.length);
  return Array.from({ length: count }, (_, r) => items.filter((_, i) => i % count === r));
}

/** Rows drift at the same reading pace whatever their length: duration follows the chips' estimated width. */
const PACE = 24; // px per second
const chipWidth = (item: Item) => 52 + item.finding.title.length * 13 + 8;

/** The stage's finding chip, led by the company's logo instead of the severity mark. */
function Chip({ item, copy }: { item: Item; copy: boolean }) {
  const { ticker, periodEnd, finding: f } = item;
  return <a className="finding-chip marquee-chip" data-kind={f.kind} data-nav href={`/companies/${ticker}?finding=${encodeURIComponent(f.id)}`}
    tabIndex={copy ? -1 : undefined} title={`${ticker} · ${report(periodEnd)} · ${KIND_LABEL[f.kind]}`}>
    <CompanyLogo ticker={ticker} small />
    <span>{f.title}</span>
    {f.watchOutcome && <i className="finding-settled" aria-label="跟踪项已有新披露">↻</i>}
  </a>;
}

/**
 * A row loops by sliding two identical halves left by one half. Each half repeats the row until it is long
 * enough to span a wide window, so the loop never shows a gap; only the first copy is reachable by keyboard and screen reader.
 */
function MarqueeRow({ items, index }: { items: Item[]; index: number }) {
  const repeat = Math.max(1, Math.ceil(10 / items.length));
  const half = Array.from({ length: repeat }, () => items).flat();
  const width = half.reduce((sum, item) => sum + chipWidth(item), 0);
  return <div className="marquee-row" data-offset={index % 2 === 1 || undefined} style={{ ["--duration" as string]: `${Math.round(width / PACE)}s` }}>
    <ul className="marquee-track">
      {[0, 1].flatMap(copy => half.map((item, i) => {
        const hidden = copy === 1 || i >= items.length;
        return <li key={`${copy}-${i}`} aria-hidden={hidden || undefined}><Chip item={item} copy={hidden} /></li>;
      }))}
    </ul>
  </div>;
}

/** Search in the middle of the page, recent companies under it, then two staggered rows of the latest findings drifting by; each opens its company at that finding. */
export function Home({ light, onToggleTheme, recent, onPick }: { light: boolean; onToggleTheme: () => void; recent: string[]; onPick: (ticker: string) => void }) {
  const tickers = [...new Set([...FINDINGS_TICKERS, ...recent])].slice(0, MAX_COMPANIES);
  const { digests, loading } = useDigests(tickers);
  const inputRef = useRef<HTMLInputElement>(null);
  // A touch keyboard would cover the findings, so only a pointer device starts in the field.
  useEffect(() => { if (matchMedia("(pointer: fine)").matches) inputRef.current?.focus({ preventScroll: true }); }, []);
  const items = interleave(digests);
  return <main className="home">
    <header className="home-top">
      <ThemeToggle light={light} onToggle={onToggleTheme} />
    </header>
    <div className="home-center">
    <section className="home-hero" aria-labelledby="home-title">
      <h1 id="home-title">Business View</h1>
      <p>从业务、产品到净利润，基于公开财报。</p>
      <SearchPanel inline current={null} recent={recent} onPick={onPick} inputRef={inputRef} />
      {recent.length > 0 && <nav className="home-recent" aria-label="最近查看">
        <span>最近查看</span>
        {recent.slice(0, 5).map(t => <a key={t} href={`/companies/${t}`} data-nav><CompanyLogo ticker={t} small />{t}</a>)}
      </nav>}
    </section>
    {(loading || items.length > 0) && <section className="home-findings" aria-label="要点" aria-busy={loading}>
      <h2 className="home-findings-title">要点<small>最新财报</small></h2>
      {items.length > 0 ? <div className="marquee">{rows(items).map((row, i) => <MarqueeRow key={i} items={row} index={i} />)}</div>
        : <div className="marquee" role="status" aria-label="正在读取要点"><div className="marquee-row"><div className="marquee-track">
          {[0, 1, 2, 3, 4, 5].map(i => <span key={i} className="finding-chip marquee-chip marquee-ghost" style={{ animationDelay: `${i * 90}ms` }} />)}
        </div></div><div className="marquee-row" data-offset><div className="marquee-track">
          {[0, 1, 2, 3, 4, 5].map(i => <span key={i} className="finding-chip marquee-chip marquee-ghost" style={{ animationDelay: `${i * 90 + 45}ms` }} />)}
        </div></div></div>}
    </section>}
    </div>
  </main>;
}
