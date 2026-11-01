import { labels } from "@/packages/web/src/i18n";
import type { FindingSeverity } from "@/shared/analysis-contract/findings";

/** What each severity is called: read out and shown on hover, never printed next to the icon. */
export const SEVERITY_LABEL = labels<`${FindingSeverity}`>({
  3: "Severity: Major (highest of 3)", 2: "Severity: Watch", 1: "Severity: Note",
}, {
  3: "严重度：重要（3 级里最高）", 2: "严重度：留意", 1: "严重度：提示",
});
export const severityLabel = (severity: FindingSeverity) => SEVERITY_LABEL[`${severity}`];

/**
 * A finding's severity as an icon in the level colours: 3 a red filled alert triangle, 2 an amber circled exclamation,
 * 1 a grey info circle. One em square on the text's line; the meaning is in its accessible name and its tooltip.
 */
export function SeverityIcon({ severity }: { severity: FindingSeverity }) {
  const label = severityLabel(severity);
  return <svg className="severity-icon" data-severity={severity} viewBox="0 0 16 16" role="img" aria-label={label}>
    <title>{label}</title>
    {severity === 3 ? <>
      <path className="severity-icon-fill" d="M8 1.6c.4 0 .8.2 1 .6l6 10.6c.4.8-.1 1.7-1 1.7H2c-.9 0-1.4-.9-1-1.7L7 2.2c.2-.4.6-.6 1-.6Z" />
      <path className="severity-icon-cut" d="M8 5.6v4M8 11.9v.1" />
    </> : severity === 2 ? <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6v4.2M8 11.2v.1" />
    </> : <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 7.4v4M8 4.7v.1" />
    </>}
  </svg>;
}
