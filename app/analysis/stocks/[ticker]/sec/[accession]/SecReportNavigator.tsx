"use client";

import { cn } from "@/lib/utils";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";

export type ReportSectionLink = {
  id: string;
  index?: string;
  title: string;
  description: string;
  depth?: 0 | 1;
  parentTitle?: string;
};

const easeOutExpo = [0.16, 1, 0.3, 1] as const;

export function SecReportNavigator({ initialSections }: { initialSections: ReportSectionLink[] }) {
  const [sections, setSections] = useState(initialSections);
  const [activeId, setActiveId] = useState(initialSections[0]?.id ?? "");
  const [menuOpen, setMenuOpen] = useState(false);
  const reduceMotion = useReducedMotion();
  const mobileMenuId = useId();
  const railRef = useRef<HTMLUListElement>(null);
  const mobileRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const railLinks = useRef(new Map<string, HTMLAnchorElement>());

  useEffect(() => {
    const container = mobileRef.current?.closest(".sec-report-shell")?.querySelector<HTMLElement>("[data-report-sections]");
    if (!container) return;

    const scan = () => {
      const discovered = Array.from(container.querySelectorAll<HTMLElement>("[data-report-nav-item='true']"))
        .map((section) => ({
          id: section.id,
          index: section.dataset.reportIndex,
          title: section.dataset.reportTitle ?? "",
          description: section.dataset.reportDescription ?? "",
          depth: section.dataset.reportDepth === "1" ? 1 as const : 0 as const,
          parentTitle: section.dataset.reportParentTitle,
        }))
        .filter((section) => section.id && section.title);
      setSections((current) => sameSections(current, discovered) ? current : discovered);
    };

    scan();
    const observer = new MutationObserver(scan);
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["id", "data-report-nav-item", "data-report-index", "data-report-title", "data-report-description", "data-report-depth", "data-report-parent-title"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const report = mobileRef.current?.closest(".sec-report-shell");
    const elements = sections.map((section) => report?.querySelector<HTMLElement>(`#${CSS.escape(section.id)}`)).filter((section): section is HTMLElement => Boolean(section));
    if (!elements.length) return;

    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => Math.abs(left.boundingClientRect.top - window.innerHeight * 0.28) - Math.abs(right.boundingClientRect.top - window.innerHeight * 0.28));
      if (visible[0]) setActiveId(visible[0].target.id);
    }, { rootMargin: "-18% 0px -70% 0px", threshold: 0 });

    elements.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [sections]);

  useEffect(() => {
    const rail = railRef.current;
    const link = railLinks.current.get(activeId);
    if (!rail || !link) return;
    const itemTop = link.offsetTop;
    const itemBottom = itemTop + link.offsetHeight;
    if (itemTop < rail.scrollTop) rail.scrollTo({ top: itemTop, behavior: reduceMotion ? "auto" : "smooth" });
    if (itemBottom > rail.scrollTop + rail.clientHeight) rail.scrollTo({ top: itemBottom - rail.clientHeight, behavior: reduceMotion ? "auto" : "smooth" });
  }, [activeId, reduceMotion]);

  const [progress, setProgress] = useState(0);
  useEffect(() => {
    let ticking = false;
    const update = () => {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      setProgress(scrollable > 0 ? Math.min(1, window.scrollY / scrollable) : 0);
      ticking = false;
    };
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!mobileRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  const activeSection = sections.find((section) => section.id === activeId) ?? sections[0];
  if (!sections.length) return null;

  const navigate = (id: string) => {
    setActiveId(id);
    setMenuOpen(false);
    const target = mobileRef.current?.closest(".sec-report-shell")?.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (target instanceof HTMLDetailsElement) target.open = true;
    window.requestAnimationFrame(() => {
      target?.scrollIntoView({ behavior: reduceMotion ? "instant" : "smooth", block: "start" });
      target?.focus({ preventScroll: true });
    });
  };

  return (
    <>
      <div aria-hidden="true" data-report-progress-track="true" className="fixed inset-x-0 top-0 z-50 h-[2px]">
        <div
          data-report-progress-fill="true"
          style={{ width: `${Math.round(progress * 1000) / 10}%` }}
          className="h-full bg-primary"
        />
      </div>
      <nav
        ref={mobileRef}
        aria-label="报告目录"
        className="relative z-30 mb-1 mt-5 min-[1360px]:hidden"
      >
        <motion.button
          ref={menuButtonRef}
          type="button"
          aria-controls={mobileMenuId}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
          whileTap={reduceMotion ? undefined : { scale: 0.985 }}
          className="flex min-h-12 w-full items-center justify-between gap-4 border-y border-[var(--paper-deep)] bg-[var(--paper)] px-1 py-3 text-left text-[var(--ink)]"
        >
          <span className="min-w-0">
            <small className="mr-3 text-[10px] font-bold tracking-[.1em] text-primary">目录</small>
            <strong className="font-[family-name:var(--serif)] text-sm font-semibold">{activeSection?.title}</strong>
          </span>
          <motion.span
            aria-hidden="true"
            animate={{ rotate: menuOpen && !reduceMotion ? 180 : 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.22, ease: easeOutExpo }}
            className="text-base text-[var(--ink-muted)]"
          >⌄</motion.span>
        </motion.button>

        <AnimatePresence initial={false}>
          {menuOpen && (
            <motion.div
              id={mobileMenuId}
              data-report-mobile-menu
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -5, scale: 0.99 }}
              transition={{ duration: reduceMotion ? 0.01 : 0.24, ease: easeOutExpo }}
              className="absolute left-0 right-0 top-[calc(100%+8px)] max-h-[62dvh] overflow-y-auto border border-[var(--paper-deep)] bg-[var(--paper)] shadow-[0_18px_48px_rgb(23_40_59/0.16)]"
            >
              {sections.map((section, index) => {
                const nested = section.depth === 1;
                return (
                <a
                  key={section.id}
                  href={`#${section.id}`}
                  data-app-local-anchor
                  aria-current={section.id === activeId ? "location" : undefined}
                  onClick={(event) => { event.preventDefault(); navigate(section.id); }}
                  className={`grid grid-cols-[36px_minmax(0,1fr)] gap-3 border-b border-[var(--paper-deep)] pr-4 text-[var(--ink)] no-underline last:border-b-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-[var(--ink)] ${nested ? "min-h-12 py-2 pl-8" : "min-h-14 px-4 py-3"}`}
                >
                  <span className="pt-1 text-[10px] font-bold tracking-[.08em] text-primary">{displayIndex(section, index)}</span>
                  <span className="min-w-0">
                    {nested && <small className="mb-0.5 block text-[9px] tracking-[.08em] text-[var(--ink-muted)]">{section.parentTitle}</small>}
                    <strong className={`block font-[family-name:var(--serif)] font-semibold leading-5 ${nested ? "text-sm" : "text-[15px]"}`}>{section.title}</strong>
                    <small className="mt-1 block text-xs leading-5 text-[var(--ink-muted)]">{section.description}</small>
                  </span>
                </a>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </nav>

      <nav
        aria-label="本页目录"
        data-report-toc="right"
        className="fixed right-[max(24px,5vw)] top-24 hidden w-[200px] min-[1360px]:block"
      >
        <h2 className="mb-4 text-sm font-medium text-muted-foreground">本页目录</h2>
        <ul ref={railRef} className="relative m-0 flex max-h-[calc(100dvh-160px)] list-none flex-col gap-1 overflow-y-auto overscroll-contain p-0">
          {sections.map((section) => (
            <li key={section.id} data-report-nav-depth={section.depth === 1 ? "subsection" : "section"}>
              <a
                ref={(link) => {
                  if (link) railLinks.current.set(section.id, link);
                  else railLinks.current.delete(section.id);
                }}
                href={`#${section.id}`}
                data-app-local-anchor
                aria-current={section.id === activeId ? "location" : undefined}
                onClick={(event) => { event.preventDefault(); navigate(section.id); }}
                className={cn(
                  "block py-1 text-sm leading-6 text-muted-foreground no-underline transition-colors hover:text-foreground focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2",
                  section.depth === 1 && "pl-4",
                  section.id === activeId && "font-medium text-foreground",
                )}
              >
                {section.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}

function formatIndex(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function displayIndex(section: ReportSectionLink, index: number): string {
  return section.index ?? formatIndex(index);
}

function sameSections(left: ReportSectionLink[], right: ReportSectionLink[]): boolean {
  return left.length === right.length && left.every((section, index) => (
    section.id === right[index]?.id
    && section.index === right[index]?.index
    && section.title === right[index]?.title
    && section.description === right[index]?.description
    && section.depth === right[index]?.depth
    && section.parentTitle === right[index]?.parentTitle
  ));
}
