import { Fragment, useEffect, useId, useRef, useState, type RefObject, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { messages, useLocale } from "@/packages/web/src/i18n";
import { langOf } from "@/packages/web/src/i18n/SourceLanguage";
import { CompanyLogo } from "./CompanyMark";
import { searchRows, tickerToOpen, type CatalogCompany, type CatalogStatus, type SearchRow } from "./home-search";

const m = messages({
  open: "Open", current: "Current", recent: "Recently viewed", popular: "Popular", companies: "Companies",
  close: "Close", search: "Search companies", select: "Select",
  placeholder: "Ticker or company name",
  notCovered: (t: string) => `${t} isn't covered yet`,
  loadingList: "Loading companies…",
  invalid: "Use letters, numbers or a company name",
  noMatch: "No matching company",
  found: (n: number) => `${n} companies found`,
}, {
  open: "打开", current: "当前", recent: "最近查看", popular: "热门", companies: "公司",
  close: "关闭", search: "搜索公司", select: "选择",
  placeholder: "输入代码或公司名",
  notCovered: (t: string) => `${t} 暂未覆盖`,
  loadingList: "正在加载公司列表…",
  invalid: "请输入代码或公司名",
  noMatch: "没有匹配的公司",
  found: (n: number) => `找到 ${n} 家公司`,
});

function highlight(text: string, query: string): ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return text;
  return <>{text.slice(0, at)}<mark>{text.slice(at, at + needle.length)}</mark>{text.slice(at + needle.length)}</>;
}

/**
 * Covered-company search. Enter opens the selected company only. An uncovered ticker stays in the list
 * and does not navigate. The dialog shows the panel in the top layer; the home page places it inline.
 */
export function SearchPanel({ current, recent, onPick, inputRef, inline = false, catalog = [], popular = [], catalogStatus = "loading" }: {
  current: string | null;
  recent: string[];
  onPick: (ticker: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  inline?: boolean;
  catalog?: CatalogCompany[];
  popular?: string[];
  catalogStatus?: CatalogStatus;
}) {
  const locale = useLocale();
  const [input, setInput] = useState("");
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState(!inline);
  const listId = useId();
  const rows = searchRows(input, catalog, recent, popular, catalogStatus);
  const options = rows.filter(row => row.kind !== "status");
  const selected = Math.min(active, Math.max(options.length - 1, 0));
  const open = expanded && (options.length > 0 || rows.some(row => row.kind === "status"));
  const companyCount = options.filter(row => row.kind === "company").length;
  const query = input.trim();

  function labelOf(row: Extract<SearchRow, { kind: "company" }>) {
    if (locale === "zh-CN" && row.nameZh) return { text: row.nameZh, lang: "zh-CN" as const };
    return { text: row.name === row.ticker ? "" : row.name, lang: langOf(row.name) };
  }

  function pick(ticker: string) {
    if (inline) {
      flushSync(() => { setInput(ticker); setExpanded(false); });
      inputRef?.current?.blur();
    }
    onPick(ticker);
  }

  function choose(index: number) {
    const ticker = tickerToOpen(options[index]);
    if (ticker) pick(ticker);
  }

  return <div className="search-panel" data-inline={inline || undefined} data-open={open || undefined}
    onBlur={e => { if (inline && !e.currentTarget.contains(e.relatedTarget)) setExpanded(false); }}>
    <form className="search-field" role="search" onSubmit={e => { e.preventDefault(); choose(selected); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4 4" />
      </svg>
      <input ref={inputRef} role="combobox" aria-label={m.search} aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={open && options[selected] ? `${listId}-${selected}` : undefined}
        value={input} placeholder={m.placeholder} maxLength={80} autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false}
        onFocus={() => { if (inline && matchMedia("(max-width: 960px)").matches) inputRef?.current?.scrollIntoView({ block: "start" }); }}
        onChange={e => { setInput(e.target.value); setActive(0); setExpanded(true); }}
        onKeyDown={e => {
          if (e.nativeEvent.isComposing || e.key === "Process") return;
          if (e.key === "Tab") { setExpanded(false); return; }
          if (e.key === "Escape") {
            if (input) { e.preventDefault(); e.stopPropagation(); setInput(""); setActive(0); return; }
            if (open) { e.preventDefault(); e.stopPropagation(); setExpanded(false); return; }
            if (inline) { e.preventDefault(); inputRef?.current?.blur(); }
            return;
          }
          if (e.key === "Home" || e.key === "End") {
            if (!open || !options.length) return;
            e.preventDefault();
            setActive(e.key === "Home" ? 0 : options.length - 1);
            return;
          }
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          setExpanded(true);
          if (options.length) setActive((selected + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
        }} />
      {inline ? <kbd aria-hidden="true">/</kbd> : <kbd>esc</kbd>}
    </form>
    <div className="search-drop" hidden={!open}>
      <div className="search-body">
        {query && <p className="search-live" aria-live="polite">{m.found(companyCount)}</p>}
        {rows.filter(row => row.kind === "status").map(row => {
          const text = row.status === "loading" ? m.loadingList : row.status === "invalid" ? m.invalid : m.noMatch;
          return <p key={row.status} className={row.status === "invalid" ? "search-error" : "search-empty"} role={row.status === "invalid" ? "alert" : "status"}>{text}</p>;
        })}
        <ul id={listId} role="listbox" aria-label={m.companies}>
          {options.map((option, i) => {
            const prev = options[i - 1];
            const group = option.kind === "company" && option.group !== "match" && (prev?.kind !== "company" || prev.group !== option.group)
              ? option.group === "recent" ? m.recent : m.popular : null;
            const name = option.kind === "company" ? labelOf(option) : null;
            return <Fragment key={option.kind === "company" ? option.ticker : `missing-${option.ticker}`}>
              {group && <li role="presentation" className="search-group">{group}</li>}
              <li id={`${listId}-${i}`} role="option" aria-selected={i === selected} aria-disabled={option.kind === "uncovered" || undefined}
                className="search-option" data-uncovered={option.kind === "uncovered" || undefined}
                onMouseMove={() => setActive(i)} onMouseDown={e => e.preventDefault()} onClick={() => choose(i)}>
                {option.kind === "company" && <CompanyLogo ticker={option.ticker} small />}
                <strong lang="en">{highlight(option.ticker, query)}</strong>
                {name?.text && <span className="search-name" lang={name.lang}>{highlight(name.text, query)}</span>}
                {option.kind === "uncovered" && <span className="search-hint">{m.notCovered(option.ticker)}</span>}
                {option.kind === "company" && option.ticker === current && <span className="search-hint">{m.current}</span>}
                {i === selected && option.kind === "company" && <kbd aria-hidden="true">↵</kbd>}
              </li>
            </Fragment>;
          })}
        </ul>
      </div>
      <footer className="search-foot" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> {m.select}</span>
        <span><kbd>↵</kbd> {m.open}</span>
        <span><kbd>esc</kbd> {m.close}</span>
      </footer>
    </div>
  </div>;
}

/** Centered company search in the top layer: native modal dialog for focus trapping, Escape and inert background. */
export function SearchDialog({ open, current, recent, onClose, onPick, catalog, popular, catalogStatus }: {
  open: boolean;
  current: string | null;
  recent: string[];
  onClose: () => void;
  onPick: (ticker: string) => void;
  catalog?: CatalogCompany[];
  popular?: string[];
  catalogStatus?: CatalogStatus;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [session, setSession] = useState(0);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setSession(n => n + 1);
      dialog.showModal();
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  return <dialog ref={ref} className="search-dialog" aria-label={m.search} onClose={onClose}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <SearchPanel key={session} current={current} recent={recent} inputRef={inputRef} catalog={catalog} popular={popular} catalogStatus={catalogStatus}
      onPick={ticker => { onPick(ticker); onClose(); }} />
  </dialog>;
}
