import type { ArtifactDocument } from "../../analysis-contract/artifact.ts";
import { nodeText, parseHtml, type HtmlNode } from "./html.ts";

/** Read only the final thesis heading; never promote a detector question or a watch condition into a conclusion. */
export function dossierPresentation(artifact: ArtifactDocument): { title: string; status: "complete" | "incomplete" } {
  const thesis = artifact.blocks.find(block => block.id === "thesis");
  const heading = (nodes: HtmlNode[]): string | null => {
    for (const node of nodes) if (node.type === "element") {
      if (node.tag === "h2") return nodeText(node.children).trim();
      const nested = heading(node.children); if (nested) return nested;
    }
    return null;
  };
  const title = thesis ? heading(parseHtml(thesis.html).nodes) ?? thesis.title : null;
  if (!title || /^(?:thesis|summary|论点|核心论点|摘要)$/i.test(title.trim())) return { title: artifact.lang === "zh-CN" ? "研究尚未完成" : "Research incomplete", status: "incomplete" };
  return { title, status: "complete" };
}
