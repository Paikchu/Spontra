"use client";

import { Button } from "@/packages/web/src/ui/button";
import { useEffect, useId, useRef, useState } from "react";

/** Keep the original analysis intact; only long paragraphs need progressive disclosure. */
export function OutlookParagraph({ text, label, className }: { text: string; label: string; className: string }) {
  const id = useId();
  const paragraph = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const element = paragraph.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      const previewHeight = Number.parseFloat(style.lineHeight) * Number.parseInt(style.getPropertyValue("--outlook-preview-lines"), 10);
      // Measure against the collapsed height even while expanded, so the collapse button stays.
      setOverflows(element.scrollHeight > previewHeight + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className={`stock-outlook__paragraph ${className}`}>
      <p ref={paragraph} id={id} className="stock-outlook__excerpt" data-expanded={expanded}>{text}</p>
      {overflows && (
        <Button variant="ghost" size="sm" type="button" className="mt-1" aria-expanded={expanded} aria-controls={id}
          aria-label={`${expanded ? "收起" : "展开"}${label}`} onClick={() => setExpanded((value) => !value)}>
          {expanded ? "收起" : "展开"}<span aria-hidden="true">{expanded ? "−" : "+"}</span>
        </Button>
      )}
    </div>
  );
}
