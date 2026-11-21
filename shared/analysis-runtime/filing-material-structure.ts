import type { MaterialBlock } from "../analysis-contract/filing-material.ts";
import { descendants, nodeText, parseMarkup, type Element } from "./financial-data/disclosure-extraction.ts";

export type MaterialTocEntry = {
  title: string;
  anchor: string | null;
  page: number | null;
  start: number;
  level: number;
  sectionId: string;
};

export type MaterialSourceSection = {
  id: string;
  title: string;
  anchor: string | null;
  page: number | null;
  endPage: number | null;
  start: number;
  end: number;
  level: number;
  headingBlockId: string | null;
  blocks: MaterialBlock[];
};

type Boundary = Omit<MaterialSourceSection, "end" | "endPage" | "blocks">;
type NativeEntry = Omit<MaterialTocEntry, "sectionId">;
type NativeDirectory = { entries: NativeEntry[]; label: MaterialBlock | null; table: Element };

const position = (block: MaterialBlock) => block.locator.start ?? 0;
const textOf = (node: Element) => nodeText(node).replace(/\s+/g, " ").trim();
const partTitle = /^Part\s+[IVX]+\s*(?:[-–—.:]|$)/i;
const itemTitle = /^Item\s+\d+[A-Z]?\s*(?:[-–—.:]|$)/i;
const noteTitle = /^(?:[+.\d]+)?(Note\s+\d+\s*[-–—:]\s*\S.*)$/i;
const numberedNoteTitle = /^(\d{1,2})\.\s+\S/;
const notesHeading = /^notes to (?:the )?(?:(?:unaudited|condensed|consolidated)\s+)*financial statements\b/i;
const contentsTitle = /^(?:table of contents|index)(?:\s*\(continued\))?$/i;
const financialIndexTitle = /^(?:index to|table of contents for) (?:the )?(?:(?:unaudited|condensed|consolidated)\s+)*financial statements\b/i;
const outlineLevel = (title: string) => partTitle.test(title) || /^signatures?$/i.test(title) ? 2 : itemTitle.test(title) ? 3 : 4;
const comparableTitle = (title: string) => title
  .toLowerCase()
  .replace(/^[a-z]\)\s+/, "")
  .replace(/[\s\p{P}]+/gu, "");

function pageStarts(nodes: readonly Element[]) {
  const starts = new Set([0]);
  for (const node of nodes) {
    const style = node.attributes.style ?? "";
    if (/(?:^|;)\s*(?:page-break-before\s*:\s*always|break-before\s*:\s*page)\b/i.test(style)) starts.add(node.start);
    if (/(?:^|;)\s*(?:page-break-after\s*:\s*always|break-after\s*:\s*page)\b/i.test(style)) starts.add(node.end);
  }
  return starts.size > 1 ? [...starts].sort((a, b) => a - b) : [];
}

function pageAt(pages: readonly number[], offset: number): number | null {
  let low = 0, high = pages.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (pages[mid]! <= offset) low = mid + 1;
    else high = mid;
  }
  return low || null;
}

function tableDirectories(nodes: readonly Element[], blocks: readonly MaterialBlock[]) {
  const anchors = new Map<string, number>();
  for (const node of nodes) {
    const id = node.attributes.id ?? (node.local === "a" ? node.attributes.name : undefined);
    if (id && !anchors.has(id)) anchors.set(id, node.start);
  }
  const firstBodyHeading = blocks.find(block => block.kind === "paragraph" && block.text === block.title &&
    (partTitle.test(block.text) || itemTitle.test(block.text)));
  const directories: NativeDirectory[] = [];
  for (const table of nodes) {
    if (table.local !== "table") continue;
    const previous = blocks.findLast(block => position(block) < table.start);
    const label = previous?.kind === "paragraph" && contentsTitle.test(previous.text) ? previous : null;
    const financialIndex = previous?.kind === "paragraph" && financialIndexTitle.test(previous.text) ? previous : null;
    if (directories.length && !financialIndex) continue;
    if (!label && !financialIndex && firstBodyHeading && table.start > position(firstBodyHeading)) continue;
    const tableNodes = descendants(table);
    const entries = new Map<number, NativeEntry>();
    let hasPageColumn = false;
    for (const row of tableNodes.filter(node => node.local === "tr")) {
      const cells = descendants(row).filter(node => node.local === "td" || node.local === "th");
      const values = cells.map(textOf).filter(Boolean);
      if (values.some(value => /^page(?:\s+no\.?)?$/i.test(value))) hasPageColumn = true;
      const labeledPage = /^\d{1,4}$/.test(values.at(-1) ?? "") ? Number(values.pop()) : null;
      const title = values.join(" ");
      if (!title) continue;
      const linked = descendants(row).flatMap(node => {
        const href = node.local === "a" ? node.attributes.href : undefined;
        if (!href?.startsWith("#")) return [];
        const anchor = href.slice(1);
        const start = anchors.get(anchor);
        return start !== undefined && start >= table.end ? [{ anchor, start }] : [];
      });
      const targets = new Map(linked.map(target => [target.start, target.anchor]));
      if (targets.size !== 1) continue;
      const target = linked[0]!;
      if (entries.has(target.start)) continue;
      entries.set(target.start, {
        title, anchor: target.anchor, start: target.start, level: financialIndex ? 4 : outlineLevel(title),
        page: labeledPage,
      });
    }
    const list = [...entries.values()];
    if (list.length < 2) continue;
    if (financialIndex) {
      const primary = directories[0]?.entries ?? [];
      const parent = primary.findLast(entry => entry.start < table.start);
      const end = primary.find(entry => entry.start > table.start)?.start ?? Infinity;
      if (!hasPageColumn || (parent && !/^Item\s+1\b.*financial statements/i.test(parent.title)) ||
        list.some(entry => entry.start >= end)) continue;
    } else if (!label && !(hasPageColumn && list.some(entry => entry.level <= 3))) continue;
    directories.push({ entries: list, label: financialIndex ?? label, table });
  }
  return directories;
}

function nativeBoundary(entry: NativeEntry, blocks: readonly MaterialBlock[], end: number): Boundary {
  const label = comparableTitle(entry.title);
  const heading = blocks.find(block => {
    if (block.kind !== "paragraph" || block.text.length > 220 || position(block) < entry.start || position(block) >= end) return false;
    const candidate = comparableTitle(block.text);
    return label === candidate || (block.text.length >= 16 && label.startsWith(candidate));
  });
  return {
    ...entry,
    id: `section-${entry.start}`,
    title: heading?.text ?? entry.title,
    headingBlockId: heading?.id ?? null,
  };
}

/** Keeps source IDs and maps page boundaries using the printed directory numbering when it is consistent. */
export function extractMaterialStructure(html: string, sourceBlocks: readonly MaterialBlock[]) {
  const { nodes } = parseMarkup(html);
  const pages = pageStarts(nodes);
  const blocks = sourceBlocks.filter(block => block.kind !== "code");
  const directories = tableDirectories(nodes, blocks);
  const nativeEntries = [
    ...new Map(directories.flatMap(directory => directory.entries).map(entry => [entry.start, entry])).values(),
  ].sort((a, b) => a.start - b.start);
  const tocBlockIds = blocks.filter(block => directories.some(directory => block.id === directory.label?.id ||
    (position(block) >= directory.table.start && position(block) < directory.table.end))).map(block => block.id);
  const excluded = new Set(tocBlockIds);
  const body = blocks.filter(block => !excluded.has(block.id));
  const physicalPage = (entry: NativeEntry) => {
    const first = body.find(block => position(block) >= entry.start);
    return first ? pageAt(pages, position(first)) : null;
  };
  const offsets = new Set(nativeEntries.flatMap(entry => {
    const physical = physicalPage(entry);
    return entry.page !== null && physical !== null ? [entry.page - physical] : [];
  }));
  const offset = offsets.size === 1 ? [...offsets][0]! : 0;
  const numberedPage = (start: number) => {
    const physical = pageAt(pages, start);
    return physical !== null && physical + offset > 0 ? physical + offset : null;
  };
  const entries = nativeEntries.map(entry => {
    const physical = physicalPage(entry);
    return { ...entry, page: entry.page ?? (physical !== null && physical + offset > 0 ? physical + offset : null) };
  });
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  const native = sorted.map((entry, i) => nativeBoundary(
    { ...entry, page: offsets.size > 1 ? physicalPage(entry) : entry.page },
    body,
    sorted[i + 1]?.start ?? html.length,
  ));
  const headingIds = new Set(native.flatMap(section => section.headingBlockId ? [section.headingBlockId] : []));
  const notesSection = native.findIndex(section => notesHeading.test(section.title));
  const notesStart = native[notesSection]?.start ?? Infinity;
  const notesEnd = notesSection < 0 ? 0 : (native[notesSection + 1]?.start ?? html.length);
  let nextNoteNumber = 1;
  const notes = body.flatMap(block => {
    if (block.kind !== "paragraph" || headingIds.has(block.id) || block.text.length > 220) return [];
    const start = position(block);
    const numbered = start >= notesStart && start < notesEnd && block.text === block.title &&
      Number(numberedNoteTitle.exec(block.text)?.[1]) === nextNoteNumber;
    if (numbered) nextNoteNumber++;
    const note = noteTitle.exec(block.text)?.[1] ?? (numbered ? block.text : null);
    if (!note && (native.length || (!partTitle.test(block.text) && !itemTitle.test(block.text) && !/^signatures?$/i.test(block.text)))) return [];
    return [{
      id: `section-${start}`, title: note ?? block.text, anchor: null, page: numberedPage(start), start,
      level: note ? 5 : outlineLevel(block.text), headingBlockId: block.id,
    }];
  });
  const boundaries: Boundary[] = [
    { id: "section-front", title: "Filing cover and introductory disclosures", anchor: null, page: numberedPage(0), start: 0, level: 2, headingBlockId: null },
    ...[...native, ...notes].sort((a, b) => a.start - b.start),
  ];
  let blockIndex = 0;
  const sections: MaterialSourceSection[] = boundaries.map((boundary, index) => {
    const end = boundaries[index + 1]?.start ?? html.length;
    const found: MaterialBlock[] = [];
    while (blockIndex < body.length && position(body[blockIndex]!) < end) {
      const block = body[blockIndex++]!;
      found.push({ ...block, locator: { ...block.locator, page: block.locator.page ?? numberedPage(position(block)) } });
    }
    return {
      ...boundary, end, blocks: found,
      page: boundary.page ?? found[0]?.locator.page ?? null,
      endPage: found.at(-1)?.locator.page ?? boundary.page,
    };
  }).filter(section => section.blocks.length);
  const byStart = new Map(sections.map(section => [section.start, section]));
  const toc: MaterialTocEntry[] = entries.flatMap(entry => {
    const section = byStart.get(entry.start);
    return section ? [{ ...entry, sectionId: section.id }] : [];
  });
  return { toc, sections, tocBlockIds, pages };
}
