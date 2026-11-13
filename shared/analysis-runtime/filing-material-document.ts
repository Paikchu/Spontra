import type { MaterialBlock, MaterialCoverage, MaterialFiling, MaterialSnapshot, MaterialSource, MaterialTable, MaterialTextRange } from "../analysis-contract/filing-material.ts";

export type MarkdownPiece = { text: string; block: MaterialBlock | null };
export type MarkdownPlan = {
  pieces: MarkdownPiece[]; ranges: Map<string, MaterialTextRange>;
  toc: MaterialSnapshot["toc"]; bytes: number; chars: number;
};

export function planMaterialMarkdown(filing: MaterialFiling, sources: MaterialSource[], tables: MaterialTable[], kept: Array<{ block: MaterialBlock; section: string }>, duplicates: MaterialCoverage["duplicates"], excluded: MaterialCoverage["excluded"]): MarkdownPlan {
  const encoder = new TextEncoder();
  const plan: MarkdownPlan = { pieces: [], ranges: new Map(), toc: [], bytes: 0, chars: 0 };
  const raw = (text: string, block: MaterialBlock | null = null) => {
    plan.pieces.push({ text, block });
    plan.bytes += encoder.encode(text).byteLength;
    plan.chars += text.length;
  };
  const line = (text: string) => {
    if (plan.pieces.length) raw("\n\n");
    const offset = plan.bytes;
    raw(text);
    return offset;
  };
  line(`# ${filing.companyName || filing.ticker} (${filing.ticker}) ${filing.form}`);
  line(`SEC filing date ${filing.filedAt}. Report period ${filing.reportDate || "not stated"}. Accession ${filing.accession}.`);
  line("## Source documents");
  for (const source of sources) line(`- [${source.filename}](${source.url}) (${source.type}, source ${source.id}, SHA-256 ${source.sha256})`);
  line("## Available CSV tables");
  for (const table of tables) line(`- ${table.tableId}: ${table.title}. ${table.description} CSV ${table.filename}. [Table](#${table.anchor}).`);
  const groups = new Map<string, MaterialBlock[]>(), byTable = new Map(tables.map(table => [table.tableId, table]));
  for (const item of kept) {
    const group = groups.get(item.section);
    if (group) group.push(item.block); else groups.set(item.section, [item.block]);
  }
  let section = 0;
  for (const [title, blocks] of groups) {
    const anchor = `material-section-${++section}`;
    const offset = line(`<a id="${anchor}"></a>\n## ${title}`), before = plan.chars;
    for (const block of blocks) {
      const anchorOffset = line(`<a id="${block.id}"></a>\n### ${block.title}\nSource [${block.filename}](${block.sourceUrl}), block ${block.id}${block.locator.page ? `, page ${block.locator.page}` : ""}.`);
      const table = block.tableId ? byTable.get(block.tableId) : null;
      if (table) line(`Table ID ${table.tableId}. CSV ${table.filename}. ${table.description}`);
      if (block.kind === "code") line("<details><summary>Complete source data</summary>\n\n");
      else raw("\n\n");
      const bodyOffset = plan.bytes, chars = block.text.length;
      raw(block.text, block);
      plan.ranges.set(block.id, { anchorOffset, offset: bodyOffset, length: plan.bytes - bodyOffset, chars, sha256: "" });
      if (block.kind === "code") raw("\n\n</details>");
    }
    plan.toc.push({ anchor, title, offset, chars: plan.chars - before - (blocks.length ? 2 : 0) });
  }
  line("## Coverage dispositions");
  for (const item of duplicates) line(`- ${item.blockId} repeats ${item.target} verbatim; its source remains archived.`);
  for (const item of excluded) line(`- ${item.blockId}: generic statement omitted. ${item.reason}`);
  raw("\n");
  return plan;
}
