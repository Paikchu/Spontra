import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * Product code treats every issuer alike: behaviour, data and copy come from filings and settings, never from code that
 * names a company. This fails the build on the three shapes such code takes: a CIK, a comparison of a ticker with a
 * literal, and a list or record of three or more tickers. Tests, fixtures and scripts are not product code.
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
/** The one sanctioned table: a second share class reads as the class EDGAR keeps the issuer's data under. */
const SANCTIONED = new Set(["shared/analysis-runtime/financial-data/policy.ts:TICKER_ALIASES"]);

const tickerName = (node: ts.Node) => /(?:^|\.)(?:ticker|symbol)$/i.test(node.getText().replace(/\?/g, ""));
const tickerLiteral = (node: ts.Node): node is ts.StringLiteralLike => ts.isStringLiteralLike(node) && TICKER.test(node.text) && !VOCABULARY.has(node.text);

export function checkIssuerLiterals(file: string, source: string): string[] {
  const errors: string[] = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const at = (node: ts.Node) => `${file}:${ast.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const owner = (node: ts.Node): string | null => {
    for (let n: ts.Node | undefined = node; n; n = n.parent) if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    return null;
  };
  const sanctioned = (node: ts.Node) => SANCTIONED.has(`${file}:${owner(node)}`);
  function visit(node: ts.Node) {
    if (ts.isStringLiteralLike(node) && CIK.test(node.text)) errors.push(`${at(node)}: CIK literal ${node.text}`);
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(node.operatorToken.kind)) {
      const [left, right] = [node.left, node.right];
      if ((tickerName(left) && tickerLiteral(right)) || (tickerName(right) && tickerLiteral(left))) errors.push(`${at(node)}: ticker compared with a literal (${node.getText()})`);
    }
    // A list of single letters is a code table (insider transaction codes), not a list of companies.
    const listed = ts.isArrayLiteralExpression(node) ? node.elements.filter(tickerLiteral) : [];
    if (listed.filter(e => e.text.length > 1).length >= 3 && !sanctioned(node)) errors.push(`${at(node)}: list of tickers`);
    if (ts.isObjectLiteralExpression(node) && !sanctioned(node)) {
      const keys = node.properties.flatMap(p => p.name && (ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name)) ? [p.name.text] : []);
      if (keys.filter(k => TICKER.test(k) && !VOCABULARY.has(k)).length >= 3) errors.push(`${at(node)}: record keyed by tickers`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return errors;
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? (["node_modules", "dist", "test", "tests", "fixtures", "__tests__"].includes(entry.name) ? Promise.resolve([]) : files(`${directory}/${entry.name}`))
    : Promise.resolve(/\.(ts|tsx)$/.test(entry.name) && !/\.(d|test)\.tsx?$/.test(entry.name) ? [`${directory}/${entry.name}`] : [])))).flat();
}

export async function checkProductCode(): Promise<string[]> {
  const paths = (await Promise.all(ROOTS.map(files))).flat();
  return (await Promise.all(paths.map(async file => checkIssuerLiterals(file, await readFile(file, "utf8"))))).flat();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = await checkProductCode();
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Issuer literals passed: product code names no company, CIK or ticker list.");
}
