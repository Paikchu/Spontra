import { useEffect, useRef, useState } from "react";
import type { ArtifactFrameMessage, PublishedArtifact } from "@/shared/analysis-contract/artifact";
import { ArtifactLanguage } from "./ArtifactLanguage";

const isDark = () => !document.documentElement.classList.contains("light");

/**
 * An analysis report (docs/analysis-html-artifact.md §8), drawn in the `/artifact-frame` sandbox: an opaque origin with
 * no network, where only the site's component script runs. The page hands it the report and the theme, sizes the
 * frame to the height it reports, and opens the links it forwards. `data-rendered` tells the visual review the report
 * has drawn.
 */
export function ArtifactFrame({ artifact, showLanguage = true }: { artifact: Pick<PublishedArtifact, "id" | "hash" | "lang" | "translation" | "title" | "html" | "css">; showLanguage?: boolean }) {
  return <>
    {showLanguage && <div className="artifact-language-row"><ArtifactLanguage artifact={artifact} /></div>}
    <Frame key={`${artifact.id}:${artifact.lang}:${artifact.hash}`} artifact={artifact} />
  </>;
}

function Frame({ artifact }: { artifact: Pick<PublishedArtifact, "title" | "html" | "css" | "lang" | "hash"> }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false), [rendered, setRendered] = useState(false), [height, setHeight] = useState(480);
  const post = (message: ArtifactFrameMessage) => frame.current?.contentWindow?.postMessage(message, "*");
  useEffect(() => {
    const listener = (event: MessageEvent<ArtifactFrameMessage>) => {
      if (!frame.current || event.source !== frame.current.contentWindow || !event.data || typeof event.data !== "object") return;
      const m = event.data;
      if (m.type === "artifact:ready") setReady(true);
      else if (m.type === "artifact:rendered") { setHeight(m.height); setRendered(true); }
      else if (m.type === "artifact:size") setHeight(m.height);
      else if (m.type === "artifact:link" && /^https:\/\//.test(m.href)) window.open(m.href, "_blank", "noopener,noreferrer");
    };
    addEventListener("message", listener);
    return () => removeEventListener("message", listener);
  }, []);
  const drawn = useRef(false);
  useEffect(() => {
    if (!ready || drawn.current) return;
    drawn.current = true;
    post({ type: "artifact:render", html: artifact.html, css: artifact.css, dark: isDark(), lang: artifact.lang });
  }, [ready]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const observer = new MutationObserver(() => post({ type: "artifact:theme", dark: isDark() }));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return <iframe ref={frame} className="artifact-frame" src="/artifact-frame" sandbox="allow-scripts" title={artifact.title}
    data-artifact-frame="" data-artifact-hash={artifact.hash} data-rendered={rendered ? "" : undefined} style={{ height }}
    onLoad={() => { if (!drawn.current) post({ type: "artifact:ping" }); }} />;
}
