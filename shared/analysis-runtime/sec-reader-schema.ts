import { z } from "zod";

export const SEC_READER_MAX_SECTIONS = 16;
const text = (max: number) => z.string().min(1).max(max);
const id = text(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/);
// Historical readers had no reference-count cap. Keep their valid source lists intact.
const references = z.array(text(180));
const layout = z.enum(["inline", "aside", "wrap", "wide"]);
// No credentials, protocol-relative URLs, backslashes or control characters. The application
// still owns persistence and source provenance; this contract never authorizes arbitrary URLs.
const httpsUrl = /^https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(?::[0-9]{1,5})?(?:[/?#][^\s\\\u0000-\u001f\u007f]*)?$/;
const assetUrl = /^(?:https:\/\/(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])(?::[0-9]{1,5})?(?:[/?#][^\s\\\u0000-\u001f\u007f]*)?|\/(?![\/\\])[^\s\\\u0000-\u001f\u007f]*)$/;
const common = { blockId: id, evidenceIds: references.max(80), groupId: id.optional(), layout: layout.optional() };

/** Values and asset URLs are resolved by the application, never supplied by chart/image blocks. */
export const SEC_READER_CONTENT_BLOCK_SCHEMA = z.discriminatedUnion("type", [
  z.strictObject({ ...common, type: z.literal("markdown"), markdown: text(1800) }),
  z.strictObject({ ...common, type: z.literal("chart"), metricKey: text(120), mark: z.enum(["line", "bar"]), title: text(120), caption: text(500) }),
  z.strictObject({ ...common, type: z.literal("image"), assetId: id, alt: text(300), caption: text(500) }),
  z.strictObject({ ...common, type: z.literal("math"), latex: text(4000), displayMode: z.boolean(), explanation: text(1000), assumption: text(500).optional() }),
  z.strictObject({ ...common, type: z.literal("table"), headers: z.array(text(160)).min(1).max(12), rows: z.array(z.array(z.string().max(1000)).min(1).max(12)).min(1).max(40), caption: text(500) }),
  z.strictObject({ ...common, type: z.literal("callout"), tone: z.enum(["neutral", "positive", "negative", "caution"]), title: text(120).optional(), text: text(1800) }),
  z.strictObject({ ...common, type: z.literal("evidence"), title: text(120).optional() }),
]);

/** Only application-persisted, ready assets belong in this manifest. */
export const SEC_READER_ASSET_SCHEMA = z.strictObject({
  assetId: id,
  src: z.string().max(2000).regex(assetUrl),
  width: z.number().int().min(1).max(20000), height: z.number().int().min(1).max(20000),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  source: z.strictObject({ kind: z.enum(["generated", "filing"]), label: text(300), url: z.string().max(2000).regex(httpsUrl).optional() }),
});

export const SEC_READER_VISUAL_SCHEMA = z.object({
  layout: z.enum(["essay", "spotlight", "comparison", "chart_focus"]), rationale: text(400),
  paragraphLabels: z.array(text(100)).max(8).optional(),
  chart: z.object({ metricKey: text(120), mark: z.enum(["line", "bar"]), title: text(120), caption: text(500) }).optional(),
  noChartReason: text(400).optional(),
});
const section = {
  id, title: text(100), role: z.enum(["business", "earnings_cash", "valuation", "bear_case", "outlook"]),
  paragraphs: z.array(text(1800)).min(2).max(8), takeaway: text(400), nodeIds: references.min(1), evidenceIds: references.min(1),
  chartMetricKey: text(120).optional(), visual: SEC_READER_VISUAL_SCHEMA.optional(),
};
export const SEC_READER_SECTION_SCHEMA = z.object({ ...section, content: z.array(SEC_READER_CONTENT_BLOCK_SCHEMA).min(2).max(32).optional() });
const report = {
  presentationWarnings: z.array(text(1000)).max(128).optional(),
  changes: z.array(z.object({ topic: text(100), kind: z.enum(["new", "changed", "continuing", "not_comparable"]), prior: text(400), current: text(500), implication: text(500), evidenceIds: references.min(1), priorEvidenceIds: references })).min(1).max(5),
  watch: z.array(z.object({ condition: text(500), deadline: text(150), consequence: text(500), evidenceIds: references.min(1) })).min(1).max(4),
  limitations: z.array(z.object({ issue: text(300), impact: text(500) })).max(8),
  assets: z.array(SEC_READER_ASSET_SCHEMA).max(32).optional(),
};

/** Source of truth for persisted data, public JSON Schema, TypeScript and stream blocks. */
export const SEC_READER_REPORT_SCHEMA = z.discriminatedUnion("version", [
  z.object({ ...report, version: z.literal("sec-reader.v1"), sections: z.array(SEC_READER_SECTION_SCHEMA).min(3).max(SEC_READER_MAX_SECTIONS) }),
  z.object({ ...report, version: z.literal("sec-reader.v2"), sections: z.array(SEC_READER_SECTION_SCHEMA.extend({ content: z.array(SEC_READER_CONTENT_BLOCK_SCHEMA).min(2).max(32) })).min(3).max(SEC_READER_MAX_SECTIONS) }),
]);
export const SEC_READER_JSON_SCHEMA = z.toJSONSchema(SEC_READER_REPORT_SCHEMA, { target: "draft-2020-12", reused: "inline" });
export type SecReaderContentBlock = z.infer<typeof SEC_READER_CONTENT_BLOCK_SCHEMA>;
export type SecReaderAsset = z.infer<typeof SEC_READER_ASSET_SCHEMA>;
export type SecReaderReport = z.infer<typeof SEC_READER_REPORT_SCHEMA>;
export type SecReaderVisual = z.infer<typeof SEC_READER_VISUAL_SCHEMA>;

/** Exports/review must cover every visible block, including formula assumptions and captions. */
export function readerContentText(content: SecReaderContentBlock[]): string[] {
  return content.map((block) => {
    switch (block.type) {
      case "markdown": return block.markdown;
      case "chart": return `${block.title}\n${block.caption}`;
      case "image": return `${block.alt}\n${block.caption}`;
      case "math": return [block.latex, block.explanation, block.assumption].filter(Boolean).join("\n");
      case "table": return [block.caption, block.headers.join(" | "), ...block.rows.map((r) => r.join(" | "))].join("\n");
      case "callout": return [block.title, block.text].filter(Boolean).join("\n");
      case "evidence": return block.title ?? "";
    }
  }).filter(Boolean);
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
/** A read adapter only. Publishing uses strict shape and separate financial/evidence gates. */
export function parseSecReaderReport(value: unknown): { reader?: SecReaderReport; warnings: string[]; unsupportedVersion?: string } {
  const root = record(value);
  if (root.version !== "sec-reader.v1" && root.version !== "sec-reader.v2") {
    return { warnings: ["报告内容版本暂不支持，已切换到兼容正文。"], unsupportedVersion: String(root.version ?? "missing") };
  }
  const warnings: string[] = [];
  const assets: SecReaderAsset[] = [];
  const assetIds = new Set<string>();
  if (Array.isArray(root.assets) && root.assets.length > 32) return { warnings: ["报告图片资源数量异常，已切换到兼容正文。"] };
  for (const raw of Array.isArray(root.assets) ? root.assets : []) {
    const result = SEC_READER_ASSET_SCHEMA.safeParse(raw);
    if (!result.success || assetIds.has(result.data.assetId)) { warnings.push("一项图片资源不可用，已保留图注。"); continue; }
    assets.push(result.data); assetIds.add(result.data.assetId);
  }
  const reservedBlockIds = new Set((Array.isArray(root.sections) ? root.sections : []).flatMap((raw) => {
    const content = record(raw).content;
    return (Array.isArray(content) ? content : []).map((block) => record(block).blockId).filter((v): v is string => typeof v === "string");
  }));
  const compatibilityId = (sectionId: string, ordinal: number) => {
    const prefix = `${sectionId.slice(0, 120)}-compat-${ordinal}`;
    let candidate = prefix, suffix = 0;
    while (reservedBlockIds.has(candidate)) candidate = `${prefix}-${++suffix}`;
    reservedBlockIds.add(candidate);
    return candidate;
  };
  const blockIds = new Set<string>();
  const sectionIds = new Set<string>();
  const sections = (Array.isArray(root.sections) ? root.sections : []).flatMap((raw, index) => {
    const row = record(raw);
    const sectionId = typeof row.id === "string" ? row.id : `sec-reader-${index + 1}`;
    if (sectionIds.has(sectionId)) { warnings.push(`第${index + 1}节标识重复，已切换到兼容正文。`); return []; }
    sectionIds.add(sectionId);
    let content: SecReaderContentBlock[] | undefined;
    let damagedProse = false;
    if (Array.isArray(row.content)) {
      content = row.content.flatMap((item) => {
        const result = SEC_READER_CONTENT_BLOCK_SCHEMA.safeParse(item);
        if (!result.success || blockIds.has(result.data.blockId)) {
          if (record(item).type === "markdown" || "markdown" in record(item)) damagedProse = true;
          warnings.push(`第${index + 1}节部分内容格式无效，已跳过该内容块。`); return [];
        }
        const block = result.data;
        if (block.type === "table" && block.rows.some((r) => r.length !== block.headers.length)) { warnings.push(`第${index + 1}节表格列数不一致，已跳过表格。`); return []; }
        blockIds.add(block.blockId);
        // Preserve the image block/description. The renderer provides a missing-asset fallback.
        if (block.type === "image" && !assetIds.has(block.assetId)) warnings.push(`第${index + 1}节图片暂不可用，已保留图注。`);
        return [block];
      });
    }
    let paragraphs = row.paragraphs;
    const prose = content?.filter((b) => b.type === "markdown").map((b) => b.markdown);
    if (!damagedProse && prose && prose.length >= 2) paragraphs = prose;
    if (root.version === "sec-reader.v2" && (damagedProse || !content || (prose?.length ?? 0) < 2) && Array.isArray(paragraphs)) {
      // Restore all last-good prose, retaining valid media in its original relative position.
      // Compatibility IDs avoid every stored block ID, including blocks in later sections.
      const fallbackProse = paragraphs.filter((p): p is string => typeof p === "string");
      const usable = new Map((content ?? []).map((block) => [block.blockId, block]));
      const restored: SecReaderContentBlock[] = [];
      let ordinal = 0;
      const restoreParagraph = (existing?: SecReaderContentBlock) => {
        const markdown = fallbackProse[ordinal++];
        if (markdown === undefined) return;
        const block: SecReaderContentBlock = existing?.type === "markdown" ? { ...existing, markdown } : {
          type: "markdown", blockId: compatibilityId(sectionId, ordinal), markdown,
          evidenceIds: Array.isArray(row.evidenceIds) ? row.evidenceIds.filter((v): v is string => typeof v === "string") : [],
        };
        blockIds.add(block.blockId); restored.push(block);
      };
      for (const rawBlock of Array.isArray(row.content) ? row.content : []) {
        const raw = record(rawBlock), existing = usable.get(String(raw.blockId));
        if (raw.type === "markdown" || "markdown" in raw) restoreParagraph(existing?.type === "markdown" ? existing : undefined);
        else if (existing) restored.push(existing);
        usable.delete(String(raw.blockId));
      }
      while (ordinal < fallbackProse.length) restoreParagraph();
      content = restored;
      warnings.push(`第${index + 1}节内容格式不完整，已显示兼容正文。`);
    }
    const visual = SEC_READER_VISUAL_SCHEMA.safeParse(row.visual);
    if (row.visual !== undefined && !visual.success) warnings.push(`第${index + 1}节版式已回退，正文保留。`);
    const result = SEC_READER_SECTION_SCHEMA.safeParse({ ...row, id: sectionId, paragraphs, ...(content ? { content } : {}), visual: visual.success ? visual.data : undefined });
    if (!result.success) { warnings.push(`第${index + 1}节结构不完整，已切换到兼容正文。`); return []; }
    return [result.data];
  });
  // Never silently publish/read a shortened article after losing a whole section.
  if (sections.length !== (Array.isArray(root.sections) ? root.sections.length : 0)) return { warnings };
  const result = SEC_READER_REPORT_SCHEMA.safeParse({ ...root, sections, ...(root.assets !== undefined ? { assets } : {}), presentationWarnings: [...new Set([...(Array.isArray(root.presentationWarnings) ? root.presentationWarnings.filter((w): w is string => typeof w === "string") : []), ...warnings])].slice(0, 128) });
  if (!result.success) return { warnings: [...warnings, "报告结构不完整，已切换到兼容正文。"] };
  return { reader: result.data, warnings };
}
