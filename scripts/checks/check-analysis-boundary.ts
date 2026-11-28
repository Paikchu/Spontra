import { readFile, readdir } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { validateRegistry } from "../../src/pipeline/registry.ts";
import { checkProductCode, selfTest } from "./check-issuer-literals.ts";

/**
 * Pure browser-safe contracts and helper modules under `src/` that `web/` is allowed to value-import.
 * Everything else imported by `web/` from `src/` MUST be `import type` so Worker/D1/R2 runtime code
 * never leaks into the browser bundle.
 */
const BROWSER_SAFE_SRC = new Set([
  "src/domains/publishing/artifact-contract.ts",
  "src/domains/publishing/artifact-theme.css",
  "src/domains/publishing/translation-runtime.ts",
  "src/domains/business-map/features-contract.ts",
  "src/domains/business-map/features-runtime.ts",
  "src/domains/financials/business-flow-contract.ts",
  "src/domains/financials/runtime/policy.ts",
  "src/lib/locale.ts",
]);

function normalizeSrcTarget(target: string): string {
  if (/\.(?:ts|tsx|css|mjs|mts)$/.test(target)) return target;
  return `${target}.ts`;
}

export function checkSourceBoundary(file: string, source: string): string[] {
  const srcFile = file.startsWith("src/");
  const webFile = file.startsWith("web/");
  if (!srcFile && !webFile) return [];
  const errors: string[] = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

  function dependency(specifier: string, typeOnly = false) {
    const target = specifier.startsWith("@/") ? specifier.slice(2)
      : specifier.startsWith(".") ? posix.normalize(posix.join(dirname(file), specifier)) : null;
    if (!target) return;

    if (srcFile) {
      if (target.startsWith("web/") || target.startsWith("scripts/")) {
        errors.push(`${file}: Worker source imports ${specifier}`);
      }
      if (!file.startsWith("src/domains/sec-archive/") && normalizeSrcTarget(target) === "src/domains/sec-archive/gateway.ts" && !typeOnly) {
        errors.push(`${file}: imports the EDGAR gateway; use src/domains/sec-archive/index.ts`);
      }
    }

    if (webFile && target.startsWith("src/") && !typeOnly) {
      const normalized = normalizeSrcTarget(target);
      if (!BROWSER_SAFE_SRC.has(normalized)) {
        errors.push(`${file}: browser UI value-imports Worker module ${specifier} (use import type or keep browser-safe)`);
      }
    }
  }

  function visit(node: ts.Node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = ts.isImportDeclaration(node)
        ? Boolean(node.importClause?.isTypeOnly || (!node.importClause?.name && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every((element) => element.isTypeOnly)))
        : Boolean(node.isTypeOnly || node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((element) => element.isTypeOnly));
      dependency(node.moduleSpecifier.text, typeOnly);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) dependency(node.argument.literal.text, true);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) dependency(argument.text);
      else errors.push(`${file}: nonliteral module loading bypasses ownership checks`);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const tokens: string[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  const executable = tokens.join(" ");
  if (srcFile && /WEB_APP_ORIGIN|\/api\/internal\//.test(executable)) errors.push(`${file}: retains a legacy Web callback`);

  // EDGAR is read in one module (docs/sec-archive.md): its listing endpoints and its download reader exist nowhere else,
  // and every other feature reads filings from the archive. Document URLs under /Archives/ stay data every module may hold.
  const archiveModule = file.startsWith("src/domains/sec-archive/");
  if (srcFile && !archiveModule && /https:\/\/(?:data\.sec\.gov|www\.sec\.gov\/(?:files|cgi-bin|include))/.test(executable)) errors.push(`${file}: reads EDGAR outside sec-archive`);
  if (srcFile && !archiveModule && /\b(?:secSubmissionsUrl|secSubmissionsPageUrl|secCompanyFactsUrl|SEC_EXCHANGE_DIRECTORY_URL|SEC_TICKERS_URL)\b/.test(executable)) errors.push(`${file}: names an EDGAR listing endpoint outside sec-archive`);
  if (srcFile && !archiveModule && /\b(?:throttledSecReader|streamSecSubmissionParts|edgarDocumentReader|pacedEdgarRequest)\b/.test(executable)) errors.push(`${file}: builds an EDGAR reader outside sec-archive`);
  return errors;
}

async function files(directory: string): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => !["node_modules", "dist", ".wrangler", ".generated"].includes(entry.name));
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? files(`${directory}/${entry.name}`)
    : Promise.resolve(/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [`${directory}/${entry.name}`] : [])))).flat();
}

export async function checkArchitecture(): Promise<string[]> {
  const paths = (await Promise.all(["src", "web"].map(files))).flat();
  return (await Promise.all(paths.map(async (file) => checkSourceBoundary(file, await readFile(file, "utf8"))))).flat();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = [...await checkArchitecture(), ...validateRegistry().map(error => `analysis events: ${error}`), ...selfTest(), ...await checkProductCode()];
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Architecture boundaries passed: Worker/browser separation is clean, EDGAR is isolated in sec-archive, and the pipeline event graph is complete and acyclic.");
}
