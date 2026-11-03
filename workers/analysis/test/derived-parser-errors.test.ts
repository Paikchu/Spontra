import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("derived filing parser failure regressions", () => {
  execFileSync(process.execPath, ["--experimental-strip-types", "--experimental-test-module-mocks", "--no-warnings", "workers/analysis/test/fixtures/derived-parser-errors.ts"], { cwd: new URL("../../../", import.meta.url), stdio: "inherit" });
});
