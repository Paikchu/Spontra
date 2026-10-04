import { Fragment, useEffect, useId, useRef, useState } from "react";
import { CompanyLogo } from "./CompanyMark";

const TICKER = /^[A-Z][A-Z0-9.-]{0,11}$/;

type Option = { ticker: string; hint: string };

/** Centered company search in the top layer: native modal dialog for focus trapping, Escape and inert background. */
export function SearchDialog({ open, current, recent, onClose, onPick }: { open: boolean; current: string; recent: string[]; onClose: () => void; onPick: (ticker: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null),
    inputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState(""),
    [active, setActive] = useState(0);
  const listId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setInput("");
      setActive(0);
      dialog.showModal();
      inputRef.current?.focus();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  const query = input.trim().toUpperCase();
  const invalid = query !== "" && !TICKER.test(query);
  /** The current company sinks to the end so Enter on an empty query moves somewhere new. */
  const matches = recent.filter(t => t.startsWith(query)).sort((a, b) => Number(a === current) - Number(b === current));
  const options: Option[] = [
    ...(query && !invalid && !matches.includes(query) ? [{ ticker: query, hint: "打开业务地图" }] : []),
    ...matches.map(t => ({ ticker: t, hint: t === current ? "当前" : "" })),
  ];
  const typed = options.length > 0 && options[0].hint === "打开业务地图";
  const selected = Math.min(active, options.length - 1);

  function pick(ticker: string) {
    onPick(ticker);
    onClose();
  }

  return <dialog ref={ref} className="search-dialog" aria-label="搜索公司" onClose={onClose}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="search-panel">
      <form className="search-field" role="search" onSubmit={e => {
        e.preventDefault();
        if (options[selected]) pick(options[selected].ticker);
      }}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" />
        </svg>
        <input ref={inputRef} role="combobox" aria-label="股票代码" aria-expanded={options.length > 0} aria-controls={listId}
          aria-activedescendant={options[selected] ? `${listId}-${selected}` : undefined} aria-invalid={invalid}
          value={input} placeholder="输入股票代码" maxLength={12} autoCapitalize="characters" autoComplete="off" spellCheck={false}
          onChange={e => { setInput(e.target.value); setActive(0); }}
          onKeyDown={e => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            if (options.length) setActive((selected + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
          }} />
        <kbd>esc</kbd>
      </form>
      <div className="search-body">
        {invalid ? <p className="search-error" role="alert">请输入有效的股票代码</p>
          : !options.length && <p className="search-empty">输入代码后按回车打开</p>}
        <ul id={listId} role="listbox" aria-label="公司">
          {options.map((option, i) => <Fragment key={option.ticker}>
            {i === (typed ? 1 : 0) && matches.length > 0 && <li role="presentation" className="search-group">最近查看</li>}
            <li id={`${listId}-${i}`} role="option" aria-selected={i === selected}
              className="search-option" onMouseMove={() => setActive(i)} onClick={() => pick(option.ticker)}>
              <CompanyLogo ticker={option.ticker} small />
              <strong>{option.ticker}</strong>
              {option.hint && <span className="search-hint">{option.hint}</span>}
              {i === selected && <kbd aria-hidden="true">↵</kbd>}
            </li>
          </Fragment>)}
        </ul>
      </div>
      <footer className="search-foot" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>↵</kbd> 打开</span>
        <span><kbd>esc</kbd> 关闭</span>
      </footer>
    </div>
  </dialog>;
}
