import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * Product code treats every issuer alike: behaviour, data and copy come from filings and settings, never from code that
 * names a company. This fails the build on the three shapes such code takes: a CIK, a comparison of a ticker with a
 * literal, and a list or record of three or more tickers. JSON beside the code is held to the same rule (a company it
 * keys or lists by ticker is data that belongs in settings), so a list cannot leave code by moving into a file the code
 * imports. Tests, fixtures and scripts are not product code.
 */
const ROOTS = ["apps/business-site/src", "apps/business-site/worker", "apps/admin/src", "apps/admin/worker", "packages/web/src", "shared", "workers/analysis/src"];
const TICKER = /^[A-Z]{1,5}(?:\.[A-Z])?$/;
const CIK = /^0\d{9}$/;
/** Upper-case words that are not tickers: periods, filing forms, ISO 4217 currencies and the like. */
const VOCABULARY = new Set([
  "FY", "Q1", "Q2", "Q3", "Q4", "H1", "H2", "M9", "TTM", "YOY", "QOQ", "GAAP", "SEC", "XBRL", "DEI", "EPS", "AI", "API", "URL", "ID", "OK",
  "USD", "EUR", "JPY", "GBP", "CNY", "HKD", "TWD", "KRW", "INR", "CAD", "AUD", "CHF", "SEK", "NOK", "DKK", "BRL", "MXN", "SGD", "ILS", "ZAR", "RUB", "NZD", "PLN", "TRY", "IDR", "THB", "MYR", "PHP", "SAR", "AED",
  "GET", "POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS",
  "INC", "CORP", "CO", "LTD", "PLC", "NV", "SA", "AG", "THE", "AND", "CLASS", "STOCK", "GROUP", "SHARES", "COMMON", "LIMITED",
]);

const tickerName = (node: ts.Node) => /(?:^|\.)(?:ticker|symbol)$/i.test(node.getText().replace(/\?/g, ""));
const tickerLiteral = (node: ts.Node): node is ts.StringLiteralLike => ts.isStringLiteralLike(node) && TICKER.test(node.text) && !VOCABULARY.has(node.text);

export function checkIssuerLiterals(file: string, source: string): string[] {
  const errors: string[] = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const at = (node: ts.Node) => `${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && CIK.test(node.text)) errors.push(`${at(node)}: CIK literal ${node.text}`);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      const [left, right] = [node.left, node.right];
      if ((tickerName(left) && tickerLiteral(right)) || (tickerName(right) && tickerLiteral(left))) errors.push(`${at(node)}: ticker compared with a literal (${node.getText()})`);
    }
    // A list of single letters is a code table (insider transaction codes), not a list of companies.
    const listed = ts.isArrayLiteralExpression(node) ? node.elements.filter(tickerLiteral) : [];
    if (listed.filter(e => e.text.length > 1).length >= 3) errors.push(`${at(node)}: list of tickers`);
    if (ts.isObjectLiteralExpression(node)) {
      const keys = node.properties.flatMap(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? [p.name.text] : []);
      // Single-letter keys are a code table (insider transaction codes), as single-letter list entries are.
      if (keys.filter(k => TICKER.test(k) && k.length > 1 && !VOCABULARY.has(k)).length >= 3) errors.push(`${at(node)}: record keyed by tickers`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return errors;
}

/** The same shapes in a JSON document: a CIK, a `ticker` or `symbol` field naming one, and a list or record of three or more tickers. */
export function checkJsonIssuers(file: string, source: string): string[] {
  let value: unknown;
  try { value = JSON.parse(source); } catch { return [`${file}: not valid JSON`]; }
  const errors: string[] = [];
  const ticker = (v: unknown): v is string => typeof v === "string" && TICKER.test(v) && v.length > 1 && !VOCABULARY.has(v);
  const visit = (node: unknown, path: string) => {
    if (typeof node === "string") { if (CIK.test(node)) errors.push(`${file}: CIK literal ${node} at ${path}`); return; }
    if (Array.isArray(node)) {
      if (node.filter(ticker).length >= 3) errors.push(`${file}: list of tickers at ${path}`);
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    const entries = Object.entries(node);
    if (entries.filter(([key]) => ticker(key)).length >= 3) errors.push(`${file}: record keyed by tickers at ${path}`);
    for (const [key, item] of entries) {
      if (/^(?:ticker|symbol)$/i.test(key) && ticker(item)) errors.push(`${file}: ${key} ${item} at ${path}`);
      visit(item, `${path}.${key}`);
    }
  };
  visit(value, "$");
  return errors;
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? (["node_modules", "dist", "test", "tests", "fixtures", "__tests__"].includes(entry.name) ? Promise.resolve([]) : files(`${directory}/${entry.name}`))
    : Promise.resolve(/\.(ts|tsx|json)$/.test(entry.name) && !/\.(d|test)\.tsx?$/.test(entry.name) ? [`${directory}/${entry.name}`] : [])))).flat();
}

export async function checkProductCode(): Promise<string[]> {
  const paths = (await Promise.all(ROOTS.map(files))).flat();
  return (await Promise.all(paths.map(async file => (file.endsWith(".json") ? checkJsonIssuers : checkIssuerLiterals)(file, await readFile(file, "utf8"))))).flat();
}

/** The detector against shapes it must and must not flag, so a broken check fails rather than passes everything. */
export function selfTest(): string[] {
  const flagged = (source: string) => checkIssuerLiterals("shared/example.ts", source).length;
  const must = [`const profiled = (cik: string) => cik === "0000000123";`, `if (ticker !== "ACME") return q;`, `if (row.ticker === "ACME") return q;`,
    `const FEATURED = ["AAA", "BBB", "CCC"];`, `const ISSUERS = { AAA: 1, BBB: 2, CCC: 3 };`];
  const mustNot = [`const P = ["FY", "Q1", "Q2", "Q3"]; const C = { USD: 1, EUR: 2, JPY: 3 };`, `const CODES = new Set(["S", "P", "M", "F"]);`, `const LABEL = { S: "Sale", P: "Purchase", M: "Exercise" };`, `if (row.ticker === "*") return;`];
  const jsonFlagged = (source: string) => checkJsonIssuers("shared/example.json", source).length;
  const jsonMust = [`{"companies":[{"ticker":"AAA","peers":["BBB"]}]}`, `{"peers":["AAA","BBB","CCC"]}`, `{"AAA":1,"BBB":2,"CCC":3}`, `{"cik":"0000000123"}`];
  const jsonMustNot = [`{"metric":"revenue","unit":"USD","periods":["FY","Q1","Q2","Q3"]}`, `{"codes":["S","P","M","F"]}`];
  return [...must.filter(s => flagged(s) !== 1).map(s => `issuer check missed: ${s}`), ...mustNot.filter(s => flagged(s) !== 0).map(s => `issuer check flagged: ${s}`),
    ...jsonMust.filter(s => jsonFlagged(s) < 1).map(s => `issuer check missed: ${s}`), ...jsonMustNot.filter(s => jsonFlagged(s) !== 0).map(s => `issuer check flagged: ${s}`)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = [...selfTest(), ...await checkProductCode()];
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Issuer literals passed: product code and its JSON name no company, CIK or ticker list.");
}
