import assert from "node:assert/strict";
import test from "node:test";
import { stageDoor, type SiteEnv } from "../worker/index.ts";

const SITE = "https://site.test";
const TOKEN = "a1.abc.def";

function door() {
  const seen: Request[] = [];
  const env = {
    SPONTRA_STAGE: { fetch: async (request: Request) => { seen.push(request); return new Response("{}", { status: 200 }); } },
  } as unknown as SiteEnv;
  return { env, seen };
}
const socket = (origin: string | null, query = "") => new Request(`${SITE}/agents/stage-agent/abc${query}`, { headers: { upgrade: "websocket", ...(origin ? { origin } : {}) } });

test("the desktop webviews may open a socket and name their reader in the address", async () => {
  for (const origin of ["tauri://localhost", "http://tauri.localhost"]) {
    const { env, seen } = door();
    const response = await stageDoor(socket(origin, `?reader=${TOKEN}&_pk=1`), env);
    assert.equal(response.status, 200);
    assert.equal(seen[0]!.headers.get("x-spontra-token"), TOKEN);
    assert.equal(new URL(seen[0]!.url).search, "?_pk=1");
  }
});

test("any other origin stays refused, reader or not", async () => {
  for (const origin of ["https://evil.test", "tauri://evil", null]) {
    const { env, seen } = door();
    assert.equal((await stageDoor(socket(origin, `?reader=${TOKEN}`), env)).status, 403);
    assert.equal(seen.length, 0);
  }
});

test("the site's own socket ignores a reader in the address and keeps its cookie", async () => {
  const { env, seen } = door();
  const request = new Request(`${SITE}/agents/stage-agent/abc?reader=forged`, { headers: { upgrade: "websocket", origin: SITE, cookie: `spontra_reader=${TOKEN}` } });
  assert.equal((await stageDoor(request, env)).status, 200);
  assert.equal(seen[0]!.headers.get("x-spontra-token"), TOKEN);
});

test("a desktop origin does not open the door for anything but a socket", async () => {
  const { env } = door();
  const request = new Request(`${SITE}/agents/conversations`, { method: "POST", headers: { origin: "tauri://localhost" }, body: "{}" });
  assert.equal((await stageDoor(request, env)).status, 403);
});
