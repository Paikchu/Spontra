import type { PeersResponse } from "../../../../shared/analysis-contract/peers.ts";
import { readPeersPublication } from "../../../../shared/analysis-runtime/peers.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { PEERS_CACHE_KEY } from "./projection.ts";

/** The stored projection, re-validated and never repaired; "preparing" until the peers task has published once. */
export async function readPeersResponse(db: D1Database): Promise<PeersResponse> {
  const stored = await new D1SecRepository(db).getCache<unknown>(PEERS_CACHE_KEY);
  const peers = stored ? readPeersPublication(stored.payload) : null;
  return { schemaVersion: "peers-response.v1", status: peers ? "ready" : "preparing", peers };
}
