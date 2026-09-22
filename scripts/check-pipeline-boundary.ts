import { readFile, readdir } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export function checkSourceBoundary(file: string, source: string): string[] {
  const contract = file.startsWith("shared/analysis-contract/");
  const runtime = file.startsWith("shared/analysis-runtime/");
  const pipeline = file.startsWith("workers/pipeline/");
  const web = /^(app|components|lib|worker)\//.test(file);
  if (!contract && !runtime && !pipeline && !web) return [];
  const errors: string[] = [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  function dependency(specifier: string, typeOnly = false) {
    const target = specifier.startsWith("@/") ? specifier.slice(2)
      : specifier.startsWith(".") ? posix.normalize(posix.join(dirname(file), specifier)) : null;
    const contractTarget = target?.startsWith("shared/analysis-contract/");
    const runtimeTarget = target?.startsWith("shared/analysis-runtime/");
    // Contracts can infer types from the pure runtime without importing its implementation.
    if (contract && !contractTarget && !(typeOnly && runtimeTarget)) errors.push(`${file}: contract imports ${specifier}`);
    if (runtime && !contractTarget && !runtimeTarget && specifier !== "zod") errors.push(`${file}: shared runtime imports ${specifier}`);
    if (pipeline && target && !target.startsWith("workers/pipeline/") && !target.startsWith("shared/analysis-contract/") && !target.startsWith("shared/analysis-runtime/")) errors.push(`${file}: Pipeline imports ${specifier}`);
    if (web && target?.startsWith("workers/pipeline/")) errors.push(`${file}: Web imports Pipeline ${specifier}`);
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
    if (runtime && ts.isIdentifier(node) && /^(?:globalThis|window|document|navigator|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket|Worker|D1Database|D1PreparedStatement|Workflow|R2Bucket|process|Deno|Bun|Buffer|crypto|setTimeout|setInterval|requestAnimationFrame)$/.test(node.text)) {
      errors.push(`${file}: shared runtime uses platform API ${node.text}`);
    }
    if (contract && (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isArrowFunction(node))) errors.push(`${file}: contract contains implementation code`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const tokens: string[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  const executable = tokens.join(" ");
  if (pipeline && /WEB_APP_ORIGIN|\/api\/internal\//.test(executable)) errors.push(`${file}: Pipeline retains a Web callback`);
  if (contract && /\b(?:D1Database|D1PreparedStatement|Workflow|R2Bucket)\b/.test(source)) errors.push(`${file}: contract contains platform state`);
  return errors;
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => entry.isDirectory()
    ? files(`${directory}/${entry.name}`)
    : Promise.resolve(/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [`${directory}/${entry.name}`] : [])))).flat();
}
export async function checkArchitecture(): Promise<string[]> {
  const paths = (await Promise.all(["app", "components", "lib", "shared", "workers", "worker"].map(files))).flat();
  return (await Promise.all(paths.map(async (file) => checkSourceBoundary(file, await readFile(file, "utf8"))))).flat();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = await checkArchitecture();
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Architecture boundaries passed: Pipeline depends only on its own code, declarative shared contracts and pure shared runtime; no Web callbacks or imports.");
}
