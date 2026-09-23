import type { ReactNode } from "react";

/* Spontra "Ink & Highlighter" primitives. Server-safe (no hooks); styles live in app/spontra-ui.css. */

const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(" ");

const ARROWS = {
  right: { edge: "M3 10H16", head: "M11.5 5.5 16 10l-4.5 4.5", dot: [4, 10] },
  up: { edge: "M10 16V4", head: "M5.5 8.5 10 4l4.5 4.5", dot: [10, 10] },
  diag: { edge: "M5 15 15 5", head: "M8.5 5H15v6.5", dot: [10, 10] },
} as const;

/** The evidence node: a dot that draws an edge and becomes an arrow on hover. */
export function NodeArrow({ dir = "right" }: { dir?: keyof typeof ARROWS }) {
  const arrow = ARROWS[dir];
  return (
    <svg className={`sp-node is-${dir}`} viewBox="0 0 20 20" aria-hidden="true">
      <path className="sp-node-edge" d={arrow.edge} pathLength={1} />
      <path className="sp-node-head" d={arrow.head} pathLength={1} />
      <circle className="sp-node-dot" cx={arrow.dot[0]} cy={arrow.dot[1]} r={3} />
    </svg>
  );
}

/** Spontra mark: two arcs and the evidence dot. Colours follow the theme. */
export function LogoMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg className={cx("sp-logo", className)} viewBox="11.5 3 24.5 42" height={size} role="img" aria-label="Spontra">
      <path className="sp-logo-stroke" d="M32.693 12.671A9 9 0 1 0 24 24A9 9 0 1 1 21.671 41.693" fill="none" strokeWidth={5} />
      <circle className="sp-logo-node" cx={16.368} cy={37.769} r={4.4} />
    </svg>
  );
}

export type EvidenceKind = "support" | "counter" | "pending";
const evidenceLabel: Record<EvidenceKind, string> = { support: "支持", counter: "反证", pending: "待确认" };

export function EvidenceTag({ kind = "support", children }: { kind?: EvidenceKind; children?: ReactNode }) {
  return (
    <span className={`sp-ev sp-ev-${kind}`}>
      <svg className="sp-ev-glyph" viewBox="0 0 10 10" aria-hidden="true">
        {kind === "counter" ? <path d="M5 1.2 9 8.6H1z" />
          : kind === "pending" ? <circle cx={5} cy={5} r={3.4} fill="none" strokeWidth={1.4} />
            : <circle cx={5} cy={5} r={3.6} />}
      </svg>
      {children ?? evidenceLabel[kind]}
    </span>
  );
}

const MINUS = "−";

/** Signed change. Always carries + or − so direction never depends on colour. */
export function Delta({ value, kind = "currency", digits = 2, pill = false }: { value: number | null | undefined; kind?: "currency" | "percent"; digits?: number; pill?: boolean }) {
  if (value == null || !Number.isFinite(value)) return <span className={cx("sp-delta is-flat", pill && "is-pill")}>–</span>;
  const tone = value > 0 ? "is-gain" : value < 0 ? "is-loss" : "is-flat";
  const sign = value > 0 ? "+" : value < 0 ? MINUS : "";
  const abs = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return <span className={cx("sp-delta", tone, pill && "is-pill")}>{kind === "percent" ? `${sign}${abs}%` : `${sign}$${abs}`}</span>;
}

export function Kicker({ children }: { children: ReactNode }) {
  return <p className="sp-kicker">{children}</p>;
}
