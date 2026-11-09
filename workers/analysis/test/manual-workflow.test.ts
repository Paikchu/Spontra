import assert from "node:assert/strict";
import test from "node:test";
import { handleSecAnalysisRequest, type SecCronEnv } from "../src/core.ts";

const env: SecCronEnv = { SEC_REFRESH_KEY: "test-key", SEC_AI_ENABLED: "true", SEC_AI_TICKERS: "AAPL" };
const post = (ticker: string, key = "test-key") => new Request(`https://analysis.test/jobs/${ticker}`, { method: "POST", headers: { "x-sec-refresh-key": key } });

test("a manual request needs the key and a tracked company", async () => {
  assert.equal((await handleSecAnalysisRequest(post("aapl", "wrong"), env)).status, 401);
  assert.equal((await handleSecAnalysisRequest(post("msft"), env)).status, 403);
});
