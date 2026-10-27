import { handleStoreRequest, sqlRepository, type TelemetrySql } from "../src/telemetry.ts";

type StoreContext = { storage: { sql: TelemetrySql } };

/**
 * One SQLite Durable Object for anonymous product events. The class is created with the business-map
 * Worker, so the dashboard can read what the public site just wrote. It never sees a raw IP.
 */
export class TelemetryStore {
  private readonly repo;
  constructor(ctx: StoreContext) {
    this.repo = sqlRepository(ctx.storage.sql);
  }
  fetch(request: Request): Promise<Response> {
    return handleStoreRequest(this.repo, request, Date.now());
  }
}
