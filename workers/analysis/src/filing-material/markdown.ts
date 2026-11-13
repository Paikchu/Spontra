import type { MaterialBlock, MaterialCoverage, MaterialFiling, MaterialIndexedBlock, MaterialMarkdown, MaterialSnapshot, MaterialSource, MaterialTable } from "../../../../shared/analysis-contract/filing-material.ts";
import { planMaterialMarkdown } from "../../../../shared/analysis-runtime/filing-material-document.ts";
import type { AnalysisEnv } from "../operations.ts";
import { materialDigest } from "./store.ts";
import { MATERIAL_READ_BYTES } from "../../../../shared/analysis-contract/filing-material.ts";

export async function writeMaterialMarkdown(env: Pick<AnalysisEnv, "SEC_FILINGS">, key: string, filing: MaterialFiling, sources: MaterialSource[], tables: MaterialTable[], allBlocks: MaterialBlock[], kept: Array<{ block: MaterialBlock; section: string }>, duplicates: MaterialCoverage["duplicates"], excluded: MaterialCoverage["excluded"]): Promise<{ markdown: MaterialMarkdown; blocks: MaterialIndexedBlock[]; toc: MaterialSnapshot["toc"] }> {
  const plan = planMaterialMarkdown(filing, sources, tables, kept, duplicates, excluded);
  const stream = new FixedLengthStream(plan.bytes), writer = stream.writable.getWriter(), encoder = new TextEncoder();
  const external = new Set<string>();
  const put = env.SEC_FILINGS.put(key, stream.readable, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  void put.catch(error => writer.abort(error).catch(() => undefined));
  try {
    for (const piece of plan.pieces) {
      const bytes = encoder.encode(piece.text);
      if (piece.block) plan.ranges.get(piece.block.id)!.sha256 = await materialDigest(bytes);
      await writer.write(bytes);
      if (piece.block && (piece.block.kind === "code" || bytes.byteLength > MATERIAL_READ_BYTES)) {
        external.add(piece.block.id); piece.block.text = "";
      }
      piece.text = "";
    }
    await writer.close();
    await put;
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    await put.catch(() => undefined);
    throw error;
  } finally { writer.releaseLock(); }
  const blocks: MaterialIndexedBlock[] = allBlocks.map(block => {
    const { text, ...meta } = block, range = plan.ranges.get(block.id) ?? null;
    return external.has(block.id) && range ? { ...meta, range, storage: "markdown", text: null }
      : { ...meta, range, storage: "inline", text };
  });
  return { markdown: { key, bytes: plan.bytes, chars: plan.chars }, blocks, toc: plan.toc };
}
