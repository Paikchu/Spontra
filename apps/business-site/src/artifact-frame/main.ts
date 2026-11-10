import "./frame.css";
import { ARTIFACT_ATTRIBUTES, ARTIFACT_ELEMENTS, type ArtifactFrameMessage } from "@/shared/analysis-contract/artifact";

/**
 * The artifact frame (docs/analysis-html-artifact.md §8). The page loads it with sandbox="allow-scripts" and no
 * allow-same-origin, so it runs at an opaque origin with no network, storage or access to the page. It receives one
 * report, checks its markup against the specification once more, and gives the shadcn components their behaviour:
 * tabs, accordions, collapsibles, tooltips, carousels, sortable tables and progress bars. Nothing in a report runs code.
 */
const post = (message: ArtifactFrameMessage) => window.parent.postMessage(message, "*");
const ELEMENTS = new Set<string>([...ARTIFACT_ELEMENTS, "article", "section"]);
const SVG = new Set(["svg", "g", "path", "rect", "line", "polyline", "polygon", "circle", "text", "tspan", "title", "defs", "lineargradient", "stop", "clippath", "desc"]);
let rendered = false;

/** Removes anything the specification does not allow; the server checked the same, so this only guards the sandbox. */
function sanitize(root: Element) {
  for (const el of [...root.querySelectorAll("*")]) {
    const tag = el.tagName.toLowerCase();
    const inChart = !!el.closest("figure[data-chart]");
    if (!ELEMENTS.has(tag) && !(inChart && SVG.has(tag))) { el.remove(); continue; }
    const allowed = new Set([...(ARTIFACT_ATTRIBUTES["*"] ?? []), ...(ARTIFACT_ATTRIBUTES[tag] ?? []), "data-block", "data-state", "data-sources", "data-artifact", "data-ticker", "data-subject", "data-version"]);
    for (const { name, value } of [...el.attributes]) {
      const lower = name.toLowerCase();
      const svgAttr = inChart && SVG.has(tag) && !lower.startsWith("on") && !/^(href|xlink:href|style)$/.test(lower);
      if (!allowed.has(lower) && !svgAttr) el.removeAttribute(name);
      if (lower === "href" && !/^https:\/\//.test(value)) el.removeAttribute(name);
    }
  }
}

const height = () => Math.ceil(document.documentElement.getBoundingClientRect().height);
const within = (root: Element, name: string) => [...root.querySelectorAll(`[data-slot="${name}"]`)];

function tabs(root: Element) {
  for (const group of within(root, "tabs")) {
    const triggers = within(group, "tabs-trigger").filter(t => t.closest('[data-slot="tabs"]') === group) as HTMLElement[];
    const panels = within(group, "tabs-content").filter(p => p.closest('[data-slot="tabs"]') === group) as HTMLElement[];
    const list = within(group, "tabs-list")[0];
    list?.setAttribute("role", "tablist");
    const select = (value: string, focus = false) => {
      triggers.forEach(t => { const on = t.dataset.value === value; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; t.dataset.state = on ? "active" : "inactive"; if (on && focus) t.focus(); });
      panels.forEach(p => { const on = p.dataset.value === value; p.hidden = !on; p.dataset.state = on ? "active" : "inactive"; });
    };
    triggers.forEach((t, i) => {
      t.setAttribute("role", "tab");
      t.addEventListener("click", () => select(t.dataset.value ?? ""));
      t.addEventListener("keydown", e => {
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (step) { e.preventDefault(); select(triggers[(i + step + triggers.length) % triggers.length]!.dataset.value ?? "", true); }
      });
    });
    panels.forEach(p => p.setAttribute("role", "tabpanel"));
    select((group as HTMLElement).dataset.default ?? triggers[0]?.dataset.value ?? "");
  }
}

function disclosures(root: Element) {
  for (const [itemSlot, triggerSlot, contentSlot] of [["accordion-item", "accordion-trigger", "accordion-content"], ["collapsible", "collapsible-trigger", "collapsible-content"]] as const) {
    for (const item of within(root, itemSlot)) {
      const trigger = within(item, triggerSlot)[0] as HTMLElement | undefined, content = within(item, contentSlot)[0] as HTMLElement | undefined;
      if (!trigger || !content) continue;
      const accordion = item.closest('[data-slot="accordion"]') as HTMLElement | null;
      const set = (open: boolean) => { trigger.setAttribute("aria-expanded", String(open)); content.hidden = !open; item.setAttribute("data-state", open ? "open" : "closed"); content.dataset.state = open ? "open" : "closed"; };
      trigger.setAttribute("role", "button");
      if (trigger.tagName !== "BUTTON") trigger.tabIndex = 0;
      trigger.addEventListener("click", () => {
        const open = trigger.getAttribute("aria-expanded") !== "true";
        if (open && accordion?.dataset.type !== "multiple") within(accordion ?? item, triggerSlot).forEach(other => { if (other !== trigger && other.getAttribute("aria-expanded") === "true") (other as HTMLElement).click(); });
        set(open);
        post({ type: "artifact:size", height: height() });
      });
      trigger.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && trigger.tagName !== "BUTTON") { e.preventDefault(); trigger.click(); } });
      set(item.getAttribute("data-default") === "open" || (accordion?.dataset.default ?? "") === (item as HTMLElement).dataset.value);
    }
  }
}

let popup: HTMLElement | null = null;
function tooltips(root: Element) {
  const show = (el: HTMLElement) => {
    const text = el.dataset.content ?? within(el, "hover-card-content")[0]?.textContent ?? "";
    if (!text) return;
    popup ??= Object.assign(document.createElement("div"), { role: "tooltip" });
    popup.setAttribute("data-artifact-popup", "");
    popup.textContent = text;
    document.body.appendChild(popup);
    const r = el.getBoundingClientRect(), w = Math.min(popup.offsetWidth, innerWidth - 24);
    popup.style.left = `${Math.max(12, Math.min(r.left, innerWidth - w - 12))}px`;
    popup.style.top = `${r.bottom + 6 + popup.offsetHeight > innerHeight ? r.top - popup.offsetHeight - 6 : r.bottom + 6}px`;
  };
  const hide = () => popup?.remove();
  for (const el of [...within(root, "tooltip"), ...within(root, "hover-card")] as HTMLElement[]) {
    el.tabIndex = 0;
    el.addEventListener("mouseenter", () => show(el)); el.addEventListener("focusin", () => show(el));
    el.addEventListener("mouseleave", hide); el.addEventListener("focusout", hide);
  }
}

function carousels(root: Element) {
  for (const c of within(root, "carousel")) {
    const track = within(c, "carousel-content")[0] as HTMLElement | undefined;
    if (!track) continue;
    const step = (dir: number) => track.scrollBy({ left: dir * track.clientWidth, behavior: "smooth" });
    within(c, "carousel-previous").forEach(b => b.addEventListener("click", () => step(-1)));
    within(c, "carousel-next").forEach(b => b.addEventListener("click", () => step(1)));
  }
}

function tables(root: Element) {
  for (const th of [...root.querySelectorAll("th[data-sort]")] as HTMLTableCellElement[]) {
    th.tabIndex = 0;
    const sort = () => {
      const table = th.closest("table"), body = table?.tBodies[0];
      if (!body) return;
      const index = [...th.parentElement!.children].indexOf(th);
      const dir = th.getAttribute("aria-sort") === "ascending" ? -1 : 1;
      table!.querySelectorAll("th[data-sort]").forEach(h => h.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", dir === 1 ? "ascending" : "descending");
      const key = (row: HTMLTableRowElement) => { const cell = row.cells[index]; const v = cell?.dataset.sortValue ?? cell?.textContent ?? ""; const n = Number(v.replace(/[^0-9.-]/g, "")); return th.dataset.sort === "text" || Number.isNaN(n) || !/\d/.test(v) ? v.trim().toLowerCase() : n; };
      [...body.rows].sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; }).forEach(r => body.appendChild(r));
    };
    th.addEventListener("click", sort);
    th.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); sort(); } });
  }
}

function progress(root: Element) {
  for (const bar of within(root, "progress") as HTMLElement[]) {
    const value = Number(bar.dataset.value), max = Number(bar.dataset.max ?? 100) || 100;
    if (!Number.isFinite(value)) continue;
    const fill = within(bar, "progress-indicator")[0] as HTMLElement | undefined ?? bar.appendChild(document.createElement("div"));
    fill.setAttribute("data-artifact-progress", "");
    fill.style.width = `${Math.max(0, Math.min(100, value / max * 100))}%`;
    bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuenow", String(value)); bar.setAttribute("aria-valuemax", String(max));
  }
}

function render(m: Extract<ArtifactFrameMessage, { type: "artifact:render" }>) {
  document.documentElement.lang = m.lang.replace(/[^a-zA-Z-]/g, "") || "en";
  document.documentElement.classList.toggle("dark", m.dark);
  document.documentElement.classList.toggle("light", !m.dark);
  const style = document.createElement("style");
  style.id = "artifact-css";
  style.textContent = m.css;
  document.head.appendChild(style);
  const holder = document.createElement("div");
  holder.innerHTML = m.html;
  sanitize(holder);
  document.body.replaceChildren(...holder.childNodes);
  const root = document.body;
  tabs(root); disclosures(root); tooltips(root); carousels(root); tables(root); progress(root);
  root.addEventListener("click", e => {
    const link = (e.target as Element).closest("a[href]");
    if (!link) return;
    e.preventDefault();
    post({ type: "artifact:link", href: (link as HTMLAnchorElement).href });
  });
  new ResizeObserver(() => post({ type: "artifact:size", height: height() })).observe(document.documentElement);
  rendered = true;
  // Fonts and the charts settle before the first height is reported.
  void document.fonts.ready.then(() => requestAnimationFrame(() => post({ type: "artifact:rendered", height: height() })));
}

window.addEventListener("message", (event: MessageEvent<ArtifactFrameMessage>) => {
  if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
  const m = event.data;
  if (m.type === "artifact:ping" && !rendered) post({ type: "artifact:ready" });
  if (m.type === "artifact:render" && !rendered) render(m);
  if (m.type === "artifact:theme") { document.documentElement.classList.toggle("dark", m.dark); document.documentElement.classList.toggle("light", !m.dark); }
});
post({ type: "artifact:ready" });
