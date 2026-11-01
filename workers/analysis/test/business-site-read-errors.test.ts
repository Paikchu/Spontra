import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

// Worker tests need the site's TypeScript path aliases; keep them in the worker scope.
test("business-site Worker audit regressions", () => {
  const executable = (process.env.PATH ?? "").split(delimiter).map(dir => join(dir, "tsx")).find(path => existsSync(path));
  if (!executable) throw new Error("tsx must be on PATH");
  const loader = join(dirname(realpathSync(executable)), "esm/index.mjs");
  execFileSync(process.execPath, ["--import", loader, "apps/business-site/worker/read-errors.test.ts"], { cwd: new URL("../../../", import.meta.url), env: { ...process.env, TSX_TSCONFIG_PATH: "apps/business-site/tsconfig.json" }, stdio: "inherit" });
});
