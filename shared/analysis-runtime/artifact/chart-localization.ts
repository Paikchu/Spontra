import type { ArtifactChart } from "../../analysis-contract/artifact.ts";
import type { CompiledAxis, CompiledChart, CompiledSeries } from "../../analysis-contract/lens-frame.ts";
import { compactMoney, compactNumber, currencyName } from "../locale.ts";
import { chartHeight } from "../lens/compile.ts";
import { formatFigure, periodLabel, tickLabel } from "../lens/format.ts";
import { renderChartSvg } from "../lens/render.ts";
import { nodeText, parseHtml } from "./html.ts";

export type ChartTranslationUnit = { id: string; text: string };
type SvgText = { id: string; from: number; to: number; text: string };
const key = (chart: ArtifactChart, field: string) => `chart:${chart.id}:${field}`;
const english = (text: string) => /[A-Za-z]{2}/.test(text);
const decode = (text: string) => nodeText(parseHtml(text).nodes);
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Numeric labels in older SVGs have no frozen chart object. Only unambiguous display forms are reformatted. */
export function localizeFinancialLabel(source: string): string | null {
  const text = source.trim();
  // Filing periods are durations, never monetary M (million) suffixes.
  const period = /^(3|6|9|12)M\s+(20\d{2})$/.exec(text);
  if (period) return `${period[2]}年前${period[1]}个月`;
  const accounting = /^(HK\$|NT\$|[$€£])\(([\d,.]+)\)(\s*(?:trillion|billion|million|thousand|bn|mn|[KMBT]))?$/i.exec(text)
    ?? /^\((HK\$|NT\$|[$€£])([\d,.]+)(\s*(?:trillion|billion|million|thousand|bn|mn|[KMBT]))?\)$/i.exec(text);
  if (accounting) return localizeFinancialLabel(`-${accounting[1]}${accounting[2]}${accounting[3] ?? ""}`);
  const symbols: Record<string, string> = { "$": "USD", "€": "EUR", "£": "GBP", "HK$": "HKD", "NT$": "TWD" };
  const scale: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12, THOUSAND: 1e3, MILLION: 1e6, BILLION: 1e9, TRILLION: 1e12, BN: 1e9, MN: 1e6 };
  const money = /^([+−-]?)(HK\$|NT\$|[$€£])([\d,]+(?:\.\d+)?)\s*(trillion|billion|million|thousand|bn|mn|[KMBT])?$/i.exec(text);
  if (money) {
    const value = Number(money[3]!.replace(/,/g, "")) * (scale[money[4]?.toUpperCase() ?? ""] ?? 1) * (money[1] === "−" || money[1] === "-" ? -1 : 1);
    const currency = symbols[money[2]!.toUpperCase()]!;
    if (!money[4]) return (money[1] === "+" ? "+" : value < 0 ? "−" : "") + Math.abs(value).toLocaleString("zh-CN", { maximumFractionDigits: Math.min(20, money[3]!.split(".")[1]?.length ?? 0) }) + currencyName(currency, "zh-CN");
    return (money[1] === "+" ? "+" : "") + compactMoney(value, currency, "zh-CN");
  }
  const code = /^([+−-]?)([\d,]+(?:\.\d+)?)([KMBT])? ([A-Z]{3})$/.exec(text);
  if (code) {
    const value = Number(code[2]!.replace(/,/g, "")) * (scale[code[3] ?? ""] ?? 1) * (code[1] === "−" || code[1] === "-" ? -1 : 1);
    return (code[1] === "+" ? "+" : "") + compactMoney(value, code[4]!, "zh-CN");
  }
  const quantity = /^([+−-]?)([\d,]+(?:\.\d+)?)\s*(trillion|billion|million|thousand|bn|mn|[KMBT])$/i.exec(text);
  if (quantity) return (quantity[1] === "-" ? "−" : quantity[1]) + compactNumber(Number(quantity[2]!.replace(/,/g, "")) * scale[quantity[3]!.toUpperCase()]!, "zh-CN");
  if (/^[+−-]?[\d,.]+\s+(?:pp|pts?|percentage points?)$/i.test(text)) return text.replace(/\s+(?:pp|pts?|percentage points?)$/i, "个百分点");
  if (/^[+−-]?[\d,.]+\s+bps$/i.test(text)) return text.replace(/\s+bps$/i, "个基点");
  if (/^[+−-]?[\d,.]+[×x]$/.test(text)) return text.replace(/[×x]$/, "倍");
  if (/^FY to \d{4}\.\d{2}$/.test(text)) return `截至 ${text.slice(6)} 财年`;
  return null;
}

/** Ranges point only into SVG text and accessibility labels; tags, CSS and geometry are never rewritten. */
function svgTexts(svg: string): SvgText[] {
  const out: SvgText[] = [], stack: string[] = [];
  let index = 0;
  for (const match of svg.matchAll(/<[^>]*>|[^<]+/g)) {
    const token = match[0], from = match.index;
    if (token.startsWith("<")) {
      const close = /^<\/([\w:-]+)/.exec(token);
      if (close) { stack.pop(); continue; }
      const tag = /^<([\w:-]+)/.exec(token)?.[1]?.toLowerCase();
      if (!tag) continue;
      for (const attr of token.matchAll(/\baria-label=("([^"]*)"|'([^']*)')/g)) {
        const value = attr[2] ?? attr[3] ?? "", offset = attr.index + attr[0].indexOf("=") + 2;
        out.push({ id: `svg:${index++}`, from: from + offset, to: from + offset + value.length, text: decode(value) });
      }
      if (!/\/>$/.test(token)) stack.push(tag);
    } else if (stack.some(tag => tag === "text" || tag === "tspan" || tag === "title" || tag === "desc") && token.trim()) {
      out.push({ id: `svg:${index++}`, from, to: from + token.length, text: decode(token) });
    }
  }
  return out;
}

export function chartTranslationUnits(chart: ArtifactChart): ChartTranslationUnit[] {
  const out: ChartTranslationUnit[] = [];
  const add = (field: string, text: string | null) => { if (text && english(text) && localizeFinancialLabel(text) === null) out.push({ id: key(chart, field), text }); };
  add("title", chart.title);
  chart.points.forEach((point, i) => { add(`point:${i}:period`, point.period); add(`point:${i}:text`, point.text); });
  if (chart.compiled) {
    const compiled = chart.compiled;
    add("compiled:title", compiled.title); add("compiled:subtitle", compiled.subtitle);
    compiled.series.forEach(series => add(`series:${series.id}:label`, series.label));
    compiled.annotations.forEach((annotation, i) => add(`annotation:${i}`, annotation.text));
    compiled.bands.forEach((band, i) => add(`band:${i}`, band.label));
  } else for (const part of svgTexts(chart.svg)) add(part.id, part.text);
  return out;
}

/** The source chart's numeric values, periods, scales, marks and references remain the frozen source's. */
export function localizeArtifactChart(chart: ArtifactChart, translations: ReadonlyMap<string, string>): ArtifactChart {
  const text = (field: string, source: string) => {
    const numeric = localizeFinancialLabel(source);
    if (numeric !== null) return numeric;
    if (!english(source)) return source;
    const translated = translations.get(key(chart, field));
    if (translated === undefined) throw new Error(`Missing chart translation: ${key(chart, field)}`);
    return translated;
  };
  const title = text("title", chart.title);
  const points = chart.points.map((point, i) => ({ ...point, period: text(`point:${i}:period`, point.period), text: text(`point:${i}:text`, point.text) }));
  if (!chart.compiled) {
    const parts = svgTexts(chart.svg).sort((a, b) => b.from - a.from);
    let svg = chart.svg;
    for (const part of parts) {
      const localized = text(part.id, part.text);
      if (localized !== part.text) svg = svg.slice(0, part.from) + escape(localized) + svg.slice(part.to);
    }
    return { ...chart, title, points, svg };
  }
  const source = chart.compiled;
  const numeric = (value: number, unit: CompiledSeries["unit"], currency: string | null, original: string | null) => {
    if (original?.endsWith("%")) return original;
    return formatFigure(value, unit, currency, undefined, "zh-CN");
  };
  const axis = (sourceAxis: CompiledAxis | null): CompiledAxis | null => sourceAxis && ({
    ...sourceAxis, ticks: sourceAxis.ticks.map(tick => ({ ...tick, label: tick.label.endsWith("%") ? tick.label : tickLabel(tick.value, sourceAxis.unit, sourceAxis.currency, undefined, "zh-CN") })),
  });
  const series = source.series.map(s => ({ ...s, label: text(`series:${s.id}:label`, s.label), text: s.values.map((v, i) => v === null ? null : numeric(v, s.unit, s.currency, s.text[i] ?? null)) }));
  const periods = source.periods.map(period => ({ ...period, label: periodLabel(period.end, source.span, "zh-CN") }));
  const latest = source.periods.length - 1;
  const compiled: CompiledChart = {
    ...source,
    title: source.title === null ? null : text("compiled:title", source.title),
    subtitle: source.subtitle === null ? null : text("compiled:subtitle", source.subtitle),
    periods,
    series,
    axes: { left: axis(source.axes.left), right: axis(source.axes.right) },
    annotations: source.annotations.map((annotation, i) => ({ ...annotation, text: text(`annotation:${i}`, annotation.text) })),
    bands: source.bands.map((band, i) => ({ ...band, label: band.label === null ? null : text(`band:${i}`, band.label) })),
    summary: `${title}，截至 ${periods[latest]?.label ?? ""} 的 ${periods.length} 个${source.span === "quarter" ? "季度" : "财年"}：${series.map(s => `${s.label} ${s.text[latest] ?? "未披露"}`).join("；")}。`,
  };
  const width = 720;
  return { ...chart, title, points, compiled, svg: renderChartSvg(compiled, { width, height: chartHeight(width, compiled.aspect) }, { still: true, locale: "zh-CN" }) };
}
