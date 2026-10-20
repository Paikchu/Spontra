/// <reference path="./assets.d.ts" />
import { useEffect, useRef, useState } from "react";
import { LENS_ASPECT, type LensHtml } from "@/shared/analysis-contract/lens";
import type { HtmlFrameMessage } from "@/shared/analysis-contract/lens-frame";
import { getLocale } from "@/packages/web/src/i18n";
import geist from "@/packages/web/fonts/Geist-Variable.woff2?url";
import { useTheme } from "./LensFrame";

/** The tallest a picture may grow, so a runaway fragment cannot push the document away. */
const MAX_HEIGHT = 1400;

/**
 * A picture the lens agent wrote as HTML. It runs in `/html-frame` at an opaque origin (sandbox without
 * allow-same-origin) under that page's own CSP, so its scripts reach neither the network nor this page.
 * The cell reserves the declared aspect until the frame reports the height its content takes.
 */
export function HtmlFrame({ picture }: { picture: LensHtml }) {
  // A frame runs one fragment for its whole life; another picture is another frame.
  return <PictureFrame key={`${picture.id}:${picture.html.length}:${picture.html.slice(0, 64)}`} picture={picture} />;
}

function PictureFrame({ picture }: { picture: LensHtml }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false), [height, setHeight] = useState<number | null>(null);
  const theme = useTheme();
  const post = (message: HtmlFrameMessage) => frame.current?.contentWindow?.postMessage(message, "*");
  useEffect(() => {
    const listener = (event: MessageEvent<HtmlFrameMessage>) => {
      if (!frame.current || event.source !== frame.current.contentWindow || !event.data || typeof event.data !== "object") return;
      const message = event.data;
      if (message.type === "html:ready") setReady(true);
      else if (message.type === "html:size" && message.id === picture.id && Number.isFinite(message.height)) setHeight(Math.min(MAX_HEIGHT, Math.max(40, Math.round(message.height))));
    };
    addEventListener("message", listener);
    return () => removeEventListener("message", listener);
  }, [picture.id]);
  // The frame writes the picture once, with the theme of that moment; later themes swap its colour variables in place.
  const drawn = useRef(false);
  useEffect(() => {
    if (!ready) return;
    if (!drawn.current) { drawn.current = true; post({ type: "html:render", id: picture.id, html: picture.html, theme, font: new URL(geist, location.href).href, lang: getLocale() }); }
    else post({ type: "html:theme", theme });
  }, [ready, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="lens-chart-cell lens-html-cell" style={{ "--aspect": LENS_ASPECT[picture.aspect], ...(height ? { height } : {}) } as React.CSSProperties}
    data-ready={height ? "" : undefined} data-frame={height ? "rendered" : ready ? "ready" : "loading"}>
    {/* The frame announces itself on load; a listener attached after that asks again. */}
    <iframe ref={frame} src="/html-frame.html" sandbox="allow-scripts" title={picture.title} onLoad={() => { if (!drawn.current) post({ type: "html:ping" }); }} />
    <p className="sr-only">{picture.title}</p>
  </div>;
}
