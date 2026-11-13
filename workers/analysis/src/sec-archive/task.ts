import { requestFilingMaterial, listFilingMaterials } from "../filing-material/index.ts";
import { discoveryStateKey, type DiscoveryState } from "../pipeline/discovery.ts";
import type { TaskImplementation, TaskOutcome } from "../pipeline/tasks.ts";
import { D1SecRepository } from "../sec/d1.ts";
import { secArchiveDocumentUrl, secArchiveRoot } from "../../../../shared/analysis-runtime/sec-sources.ts";

export const ARCHIVE_TASKS = {
  archive: {
    version: "archive.v1",
    async run(env, ticker): Promise<TaskOutcome> {
      const state = (await new D1SecRepository(env.DB!).getCache<DiscoveryState>(discoveryStateKey(ticker)))?.payload;
      if (!state?.current?.length) return { status: "done", detail: { waiting: "discovery" } };
      const existing = await listFilingMaterials(env, ticker);
      const newest = new Map<string, NonNullable<DiscoveryState["current"]>[number]>();
      for (const filing of state.current) {
        const form = filing.form.replace(/\/A$/, "");
        if (!newest.has(form)) newest.set(form, filing);
      }
      const requested: string[] = [];
      for (const filing of newest.values()) {
        if (existing.some(material => material.filing.accession === filing.accession)) continue;
        const root = secArchiveRoot(Number(state.cik), filing.accession);
        await requestFilingMaterial(env, { ticker, accession: filing.accession, cik: state.cik, companyName: state.name ?? ticker,
          form: filing.form, filedAt: filing.filingDate, reportDate: filing.reportDate,
          primaryDocument: filing.document, documentUrl: secArchiveDocumentUrl(root, filing.document),
          indexUrl: secArchiveDocumentUrl(root, `${filing.accession}-index.htm`) });
        requested.push(filing.accession);
      }
      return { status: "done", detail: { requested } };
    },
  },
} satisfies Record<string, TaskImplementation>;
