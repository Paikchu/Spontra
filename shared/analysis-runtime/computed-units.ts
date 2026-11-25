/** Deterministic arithmetic over explicitly typed source values. No labels or assumptions establish a unit. */
type Expression = { kind: "number"; value: number } | { kind: "name"; value: string } | { kind: "unary"; op: string; value: Expression } | { kind: "binary"; op: string; left: Expression; right: Expression };
type Dimension = Record<string, number>;
export type ArithmeticInput = { value: number; unit: string; kind: "fact" | "computed"; material?: { ticker: string; accession: string; version: string } };
export type ComputationProvenance = {
  unitContract: "generic-compute-units.v1"; mode: "created" | "legacy_reverified"; inputValueBasis: "base" | "source_declared";
  rawInputs: Record<string, ArithmeticInput>; effectiveInputs: Record<string, { value: number; unit: string }>;
  effectiveFormula: string; percentFormatting: "outer_ratio_times_100" | null;
  output: { value: number; unit: string; baseValue: number; baseUnit: string };
};

function parse(formula: string): Expression {
  const pattern = /\s*(?:(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|([-+*/()]))/y;
  const tokens: Array<{ kind: "number" | "name" | "op"; value: string }> = [];
  let at = 0;
  while (at < formula.length && !/^\s*$/.test(formula.slice(at))) {
    pattern.lastIndex = at;
    const found = pattern.exec(formula);
    if (!found) throw new Error(`Cannot read formula at ${formula.slice(at, at + 12)}`);
    tokens.push({ kind: found[1] !== undefined ? "number" : found[2] !== undefined ? "name" : "op", value: found[1] ?? found[2] ?? found[3]! });
    at = pattern.lastIndex;
  }
  let cursor = 0;
  const primary = (): Expression => {
    const token = tokens[cursor++];
    if (!token) throw new Error("The formula ends early");
    if (token.kind === "number") return { kind: "number", value: Number(token.value) };
    if (token.kind === "name") return { kind: "name", value: token.value };
    if (token.value === "(" ) { const value = sum(); if (tokens[cursor++]?.value !== ")") throw new Error("A bracket is not closed"); return value; }
    if (["+", "-"].includes(token.value)) return { kind: "unary", op: token.value, value: primary() };
    throw new Error(`Unexpected ${token.value}`);
  };
  const product = (): Expression => {
    let left = primary();
    while (["*", "/"].includes(tokens[cursor]?.value ?? "")) { const op = tokens[cursor++]!.value; left = { kind: "binary", op, left, right: primary() }; }
    return left;
  };
  const sum = (): Expression => {
    let left = product();
    while (["+", "-"].includes(tokens[cursor]?.value ?? "")) { const op = tokens[cursor++]!.value; left = { kind: "binary", op, left, right: product() }; }
    return left;
  };
  const tree = sum();
  if (cursor !== tokens.length) throw new Error(`Unexpected ${tokens[cursor]!.value}`);
  return tree;
}
const format = (node: Expression): string => node.kind === "number" ? String(node.value) : node.kind === "name" ? node.value : node.kind === "unary" ? `${node.op}(${format(node.value)})` : `(${format(node.left)} ${node.op} ${format(node.right)})`;
const dimensionKey = (dimension: Dimension) => Object.entries(dimension).filter(([, power]) => power).sort(([a], [b]) => a.localeCompare(b)).map(([name, power]) => `${name}^${power}`).join("*") || "ratio";
const same = (a: Dimension, b: Dimension) => dimensionKey(a) === dimensionKey(b);
const baseUnit = (dimension: Dimension) => same(dimension, {}) ? "ratio" : same(dimension, { shares: 1 }) ? "shares" : Object.keys(dimension).length === 1 && Object.values(dimension)[0] === 1 ? Object.keys(dimension)[0]! : Object.entries(dimension).filter(([, power]) => power > 0).map(([name, power]) => `${name}${power === 1 ? "" : `^${power}`}`).join("*") + "/" + Object.entries(dimension).filter(([, power]) => power < 0).map(([name, power]) => `${name}${power === -1 ? "" : `^${-power}`}`).join("*");
const CURRENCIES = new Set(["USD", "EUR", "GBP", "JPY", "CNY", "HKD", "TWD", "KRW", "INR", "CAD", "AUD", "CHF", "SEK", "NOK", "DKK", "BRL", "MXN", "SGD", "ILS", "ZAR", "RUB", "NZD", "PLN", "TRY", "IDR", "THB", "MYR", "PHP", "SAR", "AED"]);
export function arithmeticUnit(unit: string): { dimension: Dimension; scale: number; baseUnit: string; ratioEvidence: boolean } {
  const name = unit.toLowerCase().replace(/[\s_()]/g, "");
  const scale = (suffix = "") => /^(k|thousands?)$/.test(suffix) ? 1e3 : /^(m|mm|mn|millions?)$/.test(suffix) ? 1e6 : /^(b|bn|billions?)$/.test(suffix) ? 1e9 : 1;
  let dimension: Dimension, factor = 1;
  if (["ratio", "pure", "number", "decimal", "fraction", "ratedecimal", "x"].includes(name)) dimension = {};
  else if (["percent", "%", "ratepercent", "percentagepoints"].includes(name)) { dimension = {}; factor = 0.01; }
  else if (["bp", "bps", "basispoint", "basispoints"].includes(name)) { dimension = {}; factor = 0.0001; }
  else if (["days", "day", "years", "year"].includes(name)) dimension = { [name.startsWith("day") ? "days" : "years"]: 1 };
  else {
    const shares = /^shares?(k|thousands?|m|mm|mn|millions?|b|bn|billions?)?$/.exec(name);
    const money = /^([a-z]{3})(k|thousands?|m|mm|mn|millions?|b|bn|billions?)?(\/shares?)?$/.exec(name);
    if (shares) { dimension = { shares: 1 }; factor = scale(shares[1]); }
    else if (money && CURRENCIES.has(money[1]!.toUpperCase())) { dimension = { [money[1]!.toUpperCase()]: 1, ...(money[3] ? { shares: -1 } : {}) }; factor = scale(money[2]); }
    else throw new Error(`Unknown or unsupported source/output unit: ${unit}`);
  }
  return { dimension, scale: factor, baseUnit: baseUnit(dimension), ratioEvidence: same(dimension, {}) && name !== "number" };
}
export function arithmeticValueInUnit(input: { value: number; unit: string }, unit: string): number {
  const from = arithmeticUnit(input.unit), to = arithmeticUnit(unit);
  if (!same(from.dimension, to.dimension)) throw new Error(`Incompatible units: ${input.unit} and ${unit}`);
  return input.value * from.scale / to.scale;
}
/** Explicit display units are checked against the calculation, never used as evidence for its source units. */
export function computedDisplayIssue(computed: { value: number; unit: string }, binding: { value: string | null; unit: string | null; text: string }): string | null {
  try {
    const source = arithmeticUnit(computed.unit), expected = computed.value * source.scale;
    if (binding.value === null || !Number.isFinite(Number(binding.value))) return "A computed figure needs its numeric value attribute";
    const declared = arithmeticValueInUnit({ value: Number(binding.value), unit: binding.unit ?? computed.unit }, computed.unit);
    if (Math.abs(declared - computed.value) > Number.EPSILON * 32 * Math.max(1, Math.abs(computed.value))) return `Figure value ${binding.value} ${binding.unit ?? computed.unit} differs from computed ${computed.value} ${computed.unit}`;
    // In financial tables the scale may sit outside the accounting parentheses, e.g. $(303)m.
    const display = binding.text.replace(/^(\s*[$€£¥]?)\(\s*(\d[\d,]*(?:\.\d+)?)\s*\)(?=\s*(?:[a-z%]|$))/i, "$1-$2").replace(/−/g, "-");
    const match = /(-?\d[\d,]*(?:\.\d+)?)\s*(trillions?|billions?|millions?|thousands?|bn|mn|mm|[mbk])?(?:\b|(?=%))/i.exec(display);
    if (!match) return null;
    const explicitCurrency = display.toUpperCase().match(/\b[A-Z]{3}(?=\s*[-+]?\s*\d|\b)/g)?.find(value => CURRENCIES.has(value));
    const money = !!explicitCurrency || /[$€£¥]|\b(?:dollars?|euros?)\b/i.test(display), percent = /%|\bpercent\b/i.test(display), shares = /\bshares?\b/i.test(display), perShare = /\bper\s+shares?\b|\/\s*shares?\b/i.test(display);
    if (!money && !percent && !shares && !match[2]) return null;
    const suffix = (match[2] ?? "").toLowerCase(), multiplier = /^t/.test(suffix) ? 1e12 : /^(b|bn|billions?)$/.test(suffix) ? 1e9 : /^(m|mn|mm|millions?)$/.test(suffix) ? 1e6 : /^(k|thousands?)$/.test(suffix) ? 1e3 : 1;
    const currency = /^[A-Z]{3}(?=\/|$)/.exec(source.baseUnit)?.[0];
    const displayedUnit = percent ? "percent" : money && (explicitCurrency || currency) ? `${explicitCurrency ?? currency}${perShare ? "/shares" : ""}` : shares ? "shares" : currency ? source.baseUnit : computed.unit;
    if (money && !currency) return "A monetary display cannot cite a non-monetary computation";
    const prefix = display.slice(0, match.index), negative = !match[1]!.startsWith("-") && (/[-−]\s*[$€£¥]\s*$/.test(prefix) || /^\s*\([^)]*$/.test(prefix) && /\)\s*$/.test(display));
    const displayed = Number(match[1]!.replace(/,/g, "")) * multiplier * (negative ? -1 : 1);
    const normalized = arithmeticValueInUnit({ value: displayed, unit: displayedUnit }, computed.unit) * source.scale;
    const decimals = match[1]!.split(".")[1]?.length ?? 0;
    const tolerance = arithmeticValueInUnit({ value: 0.5 * 10 ** -decimals * multiplier, unit: displayedUnit }, computed.unit) * source.scale;
    return Math.abs(normalized - expected) <= Math.max(Math.abs(tolerance), Math.abs(expected) * Number.EPSILON * 32) ? null : `Shown ${binding.text} differs from computed ${computed.value} ${computed.unit}; fix its explicit unit/scale or recompute`;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}
export function arithmeticNames(formula: string): string[] {
  const names = new Set<string>();
  const walk = (node: Expression) => { if (node.kind === "name") names.add(node.value); else if (node.kind === "unary") walk(node.value); else if (node.kind === "binary") { walk(node.left); walk(node.right); } };
  walk(parse(formula)); return [...names];
}
/** Retained for legacy published-report checks which predate the typed producer contract. */
export function evaluateArithmetic(formula: string, inputs: Record<string, number>): number {
  const walk = (node: Expression): number => {
    if (node.kind === "number") return node.value;
    if (node.kind === "name") { if (inputs[node.value] === undefined) throw new Error(`Unknown input ${node.value}`); return inputs[node.value]!; }
    if (node.kind === "unary") return (node.op === "-" ? -1 : 1) * walk(node.value);
    const left = walk(node.left), right = walk(node.right);
    if (node.op === "/" && right === 0) throw new Error("Division by zero");
    return node.op === "+" ? left + right : node.op === "-" ? left - right : node.op === "*" ? left * right : left / right;
  };
  const value = walk(parse(formula)); if (!Number.isFinite(value)) throw new Error("Non-finite calculation"); return value;
}

export function calculateTyped(formula: string, rawInputs: Record<string, ArithmeticInput>, unit: string): { value: number; inputs: Record<string, number>; provenance: ComputationProvenance } {
  const target = arithmeticUnit(unit), tree = parse(formula), effectiveInputs: ComputationProvenance["effectiveInputs"] = {};
  const percentOutput = ["percent", "%", "ratepercent", "percentagepoints"].includes(unit.toLowerCase().replace(/[\s_()]/g, ""));
  for (const name of arithmeticNames(formula)) {
    const input = rawInputs[name]; if (!input || !Number.isFinite(input.value)) throw new Error(`Missing typed source ${name}`);
    const source = arithmeticUnit(input.unit); effectiveInputs[name] = { value: input.value * source.scale, unit: source.baseUnit };
  }
  type Quantity = { value: number; dimension: Dimension; ratioEvidence: boolean };
  const walk = (node: Expression): Quantity => {
    if (node.kind === "number") return { value: node.value, dimension: {}, ratioEvidence: false };
    if (node.kind === "name") { const source = arithmeticUnit(rawInputs[node.value]!.unit); return { value: effectiveInputs[node.value]!.value, dimension: source.dimension, ratioEvidence: source.ratioEvidence }; }
    if (node.kind === "unary") { const result = walk(node.value); return { ...result, value: (node.op === "-" ? -1 : 1) * result.value }; }
    const left = walk(node.left), right = walk(node.right);
    if (percentOutput && node !== tree && node.op === "*" && (node.right.kind === "number" && right.value === 100 && left.ratioEvidence || node.left.kind === "number" && left.value === 100 && right.ratioEvidence)) throw new Error("Ambiguous intermediate percent ×100; use canonical ratios and one outer ×100, or omit explicit formatting");
    let dimension = { ...left.dimension };
    if (["+", "-"].includes(node.op)) {
      if (!same(left.dimension, right.dimension)) {
        if (node.left.kind === "number" && left.value === 0) dimension = right.dimension;
        else if (!(node.right.kind === "number" && right.value === 0)) throw new Error(`Incompatible arithmetic dimensions: ${baseUnit(left.dimension)} ${node.op} ${baseUnit(right.dimension)}`);
      }
    } else for (const [name, power] of Object.entries(right.dimension)) { dimension[name] = (dimension[name] ?? 0) + (node.op === "*" ? power : -power); if (!dimension[name]) delete dimension[name]; }
    if (node.op === "/" && right.value === 0) throw new Error("Division by zero");
    const value = node.op === "+" ? left.value + right.value : node.op === "-" ? left.value - right.value : node.op === "*" ? left.value * right.value : left.value / right.value;
    if (!Number.isFinite(value)) throw new Error("Non-finite calculation");
    return { value, dimension, ratioEvidence: left.ratioEvidence || right.ratioEvidence || node.op === "/" && !same(left.dimension, {}) && same(left.dimension, right.dimension) };
  };
  const percentRoot = tree.kind === "binary" && tree.op === "*" ? tree.right.kind === "number" && tree.right.value === 100 ? tree.left : tree.left.kind === "number" && tree.left.value === 100 ? tree.right : null : null;
  let effectiveTree = tree, percentFormatting: ComputationProvenance["percentFormatting"] = null;
  if (percentOutput && percentRoot) {
    const candidate = walk(percentRoot);
    if (!same(candidate.dimension, {}) || !candidate.ratioEvidence) throw new Error("An outer percent ×100 requires a typed ratio or a same-unit division, not an arbitrary scalar or amount");
    effectiveTree = percentRoot; percentFormatting = "outer_ratio_times_100";
  }
  const result = walk(effectiveTree);
  if (!same(result.dimension, target.dimension)) throw new Error(`Formula produces ${baseUnit(result.dimension)}, not ${unit}`);
  const value = result.value / target.scale;
  if (!Number.isFinite(value)) throw new Error("Non-finite calculation");
  return { value, inputs: Object.fromEntries(Object.entries(effectiveInputs).map(([name, input]) => [name, input.value])), provenance: { unitContract: "generic-compute-units.v1", mode: "created", inputValueBasis: "base", rawInputs, effectiveInputs, effectiveFormula: format(effectiveTree), percentFormatting, output: { value, unit, baseValue: result.value, baseUnit: target.baseUnit } } };
}
