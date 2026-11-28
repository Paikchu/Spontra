import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/web/shared/ui/table";
import { createElement, memo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ElementContent } from "hast";
import type { Root } from "mdast";
import type { Plugin } from "unified";

const anchorPrefix = "filing-heading-";
const legacyAnchor = /^<a id="(material-section-\d+|b[a-f\d]+|d[a-f\d]+-header)"><\/a>/;

// The archival generator puts its anchor on the line before a heading.
const readLegacyHeadings: Plugin<[], Root> = function () {
  return tree => {
    tree.children = tree.children.flatMap((node, index, siblings) => {
      const following = siblings[index + 1];
      if (node.type === "paragraph" && node.children.every(child => child.type === "html") && following?.type === "heading") {
        const html = node.children.map(child => child.value).join("");
        const anchor = legacyAnchor.exec(html);
        if (anchor?.[0] === html) {
          following.data = { hProperties: { id: anchorPrefix + anchor[1] } };
          return [];
        }
      }
      const match = node.type === "html" ? legacyAnchor.exec(node.value) : null;
      if (!match || node.type !== "html") return [node];
      const fragment = this.parse(node.value.slice(match[0].length).trimStart()) as Root;
      const first = fragment.children[0];
      if (first?.type !== "heading") return [node];
      first.data = { hProperties: { id: anchorPrefix + match[1] } };
      return fragment.children;
    });
  };
};

function nodeText(node: ElementContent): string {
  if (node.type === "text") return node.value;
  return node.type === "element" ? node.children.map(nodeText).join("") : "";
}

function heading(tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6"): Components["h1"] {
  return ({ id, node, children }) => {
    const slug = node?.children.map(nodeText).join("").toLowerCase()
      .replace(/[^\p{L}\p{N} -]/gu, "").replace(/ /g, "-");
    return createElement(tag, { id: id ?? (slug ? anchorPrefix + slug : undefined) }, children);
  };
}

function filingUrl(url: string) {
  if (url.startsWith("#")) return `#${anchorPrefix}${url.slice(1)}`;
  return /^https:\/\//i.test(url) ? url : "";
}

const components: Components = {
  h1: heading("h1"), h2: heading("h2"), h3: heading("h3"),
  h4: heading("h4"), h5: heading("h5"), h6: heading("h6"),
  a: ({ href, children }) => href
    ? <a href={href} {...(href.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>{children}</a>
    : <span>{children}</span>,
  img: ({ alt }) => alt ? <span>{alt}</span> : null,
  thead: ({ children }) => <TableHeader>{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow>{children}</TableRow>,
  th: ({ children, style }) => <TableHead style={style}>{children}</TableHead>,
  td: ({ children, style }) => <TableCell className="whitespace-normal" style={style}>{children}</TableCell>,
  table: ({ children }) => (
    <div className="min-w-0" role="region" aria-label="报告内的表格" tabIndex={0}>
      <Table>{children}</Table>
    </div>
  ),
};

export const FilingMarkdown = memo(function FilingMarkdown({ text }: { text: string }) {
  return <article className="fm2-report"><Markdown skipHtml remarkPlugins={[remarkGfm, readLegacyHeadings]} components={components} urlTransform={filingUrl}>{text}</Markdown></article>;
});
