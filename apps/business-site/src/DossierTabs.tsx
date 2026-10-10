import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

/** One section of a dossier at a time; which sections exist depends on the business. Arrow keys move between tabs. */
export function DossierTabs({ label, sections, initial = 0 }: { label: string; sections: Array<[string, ReactNode]>; initial?: number }) {
  const [chosen, setChosen] = useState(initial);
  const tabs = useRef<HTMLDivElement>(null);
  const id = useId();
  if (!sections.length) return null;
  const active = Math.min(chosen, sections.length - 1);
  const choose = (index: number, focus = false) => {
    setChosen(index);
    const list = tabs.current, scroller = list?.closest<HTMLElement>(".fc-business-scroll");
    // Switching from further down the card starts the new section at its top, under the sticky tabs.
    if (list && scroller) {
      const top = list.parentElement!.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - parseFloat(getComputedStyle(scroller).paddingTop);
      if (scroller.scrollTop > top) scroller.scrollTop = top;
    }
    if (focus) list?.querySelectorAll<HTMLButtonElement>("[role=tab]")[index]?.focus();
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const index = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : step ? (active + step + sections.length) % sections.length : -1;
    if (index < 0) return;
    event.preventDefault();
    choose(index, true);
  };
  return <div className="dossier-tabs">
    <div ref={tabs} className="dossier-tablist" role="tablist" aria-label={`${label} 业务说明`} onKeyDown={onKey}>
      {sections.map(([name], i) => <button key={i} type="button" role="tab" id={`${id}-tab-${i}`} aria-selected={i === active} aria-controls={`${id}-panel`} tabIndex={i === active ? 0 : -1} onClick={() => choose(i)}>{name}</button>)}
    </div>
    <div className="dossier-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${active}`} key={active}>{sections[active][1]}</div>
  </div>;
}
