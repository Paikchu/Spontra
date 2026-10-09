import { Fragment } from "react";

import { parseRichText, type BlockNode, type InlineNode } from "@/packages/web/src/model/rich-text.ts";

/**
 * Renders model-written prose. The parser hands back an AST and this builds React elements from it,
 * so nothing the model writes is ever interpreted as markup — `<script>` arrives as text, because
 * text is the only thing that is ever produced.
 *
 * A fragment, not a wrapper: prose without markup renders exactly the paragraphs the page rendered
 * before, so existing `.sec-report-body p` styling and its first-paragraph rule keep applying.
 */
export function RichText({ text }: { text: string }) {
  const blocks = parseRichText(text);
  if (blocks.length === 0) return null;
  return <>{blocks.map((block, index) => <Block block={block} key={`${block.type}-${index}`} />)}</>;
}

function Block({ block }: { block: BlockNode }) {
  if (block.type === "heading") {
    const Heading = block.level === 3 ? "h3" : "h4";
    return <Heading className="rich-text-heading"><Inline nodes={block.inline} /></Heading>;
  }
  if (block.type === "list") {
    const items = block.items.map((item, index) => <li key={index}><Inline nodes={item} /></li>);
    return block.ordered
      ? <ol className="rich-text-list">{items}</ol>
      : <ul className="rich-text-list">{items}</ul>;
  }
  return <p><Inline nodes={block.inline} /></p>;
}

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.type === "strong") return <strong key={index}>{node.value}</strong>;
        if (node.type === "code") return <code className="rich-text-code" key={index}>{node.value}</code>;
        if (node.type === "link") {
          // Only https and same-site paths survive parsing; the rest arrive here as plain text.
          const external = node.href.startsWith("https://");
          return (
            <a href={node.href} key={index} {...(external ? { rel: "noopener noreferrer", target: "_blank" } : {})}>
              {node.value}{external ? " ↗" : ""}
            </a>
          );
        }
        // A keyed Fragment, not a span: text with no markup must reach the DOM as bare text, or
        // prose that carries none would render differently than it did before this existed.
        return <Fragment key={index}>{node.value}</Fragment>;
      })}
    </>
  );
}
