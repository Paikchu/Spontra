import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const entryPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const entry = readFileSync(entryPath, "utf8");

function compileAdapter(incompatibleAttempt = false): string[] {
  const start = entry.indexOf("const WORKFLOW_RETRY =");
  const end = entry.indexOf("export class SecAnalysisWorkflow");
  assert.ok(start >= 0 && end > start);
  const adapter = entry.slice(start, end);
  // Compile the actual adapter in isolation against the installed platform declarations.
  // Its domain/storage dependencies are declarations only: no network or storage access.
  const fixturePath = fileURLToPath(new URL("./workflow-attempt.fixture.ts", import.meta.url));
  const source = `
    import type { WorkflowStep, WorkflowStepConfig, WorkflowStepContext } from "cloudflare:workers";
    type WorkflowStepContextLike = Pick<WorkflowStepContext, "attempt">;
    type WorkflowStepLike = {
      do<T>(name: string, callback: (context?: WorkflowStepContextLike) => Promise<T>): Promise<T>;
    };
    type AnalysisEnv = { SEC_FILINGS: unknown };
    type StoredResult = { __secStoredStepResult: "v1"; key: string; sha256: string };
    declare function storeWorkflowResult<T>(bucket: unknown, instance: string, name: string, value: T): Promise<T | StoredResult>;
    declare function loadWorkflowResult<T>(bucket: unknown, value: T | StoredResult): Promise<T>;
    declare function retryDelayForAttempt(attempt: number): number;
    declare const SEC_WORKFLOW_STEP_TIMEOUT: "30 minutes";
    declare class SecModelHttpError extends Error { status: number; providerCode?: string; }
    declare class NonRetryableError extends Error {}
    type IncompatibleAttemptStep = {
      do<T extends Rpc.Serializable<T>>(name: string, config: WorkflowStepConfig,
        callback: (ctx: { attempt: string }) => Promise<T>): Promise<T>;
    };
    ${incompatibleAttempt ? adapter.replace("step: WorkflowStep,", "step: IncompatibleAttemptStep,") : adapter}
  `;
  const options: ts.CompilerOptions = {
    strict: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: ["@cloudflare/workers-types"],
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = (path) => path === fixturePath ? source : readFile(path);
  return ts.getPreEmitDiagnostics(ts.createProgram([fixturePath], options, host))
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

test("Workflow adapters do not bypass platform checking with double assertions", () => {
  assert.doesNotMatch(entry, /\bas unknown as\b/);
});

test("durable adapter compiles against the installed platform types", () => {
  assert.deepEqual(compileAdapter(), []);
});

test("durable adapter rejects an incompatible platform attempt context", () => {
  assert.ok(compileAdapter(true).some((message) => /attempt/.test(message)
    && /string/.test(message) && /number/.test(message)),
  "Expected a compile error at the adapter boundary for attempt: string");
});
