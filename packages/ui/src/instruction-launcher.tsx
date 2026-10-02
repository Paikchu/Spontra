"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { BellRing, Calculator, Command, Columns2, ListChecks, X } from "lucide-react";
import { useLanguage } from "@/app/language-provider";

/**
 * Instruction launcher (front end only). The user describes a page; the research Agent will later
 * generate an interactive page from it instead of replying in a chat thread. Generation is not wired yet.
 */
const TEMPLATES = [
  { id: "review", icon: ListChecks, title: "复核清单", detail: "按证据状态和仓位，排出今天该看的持仓", prompt: "帮我看看哪些持仓最需要我今天花时间复核" },
  { id: "compare", icon: Columns2, title: "公司对比", detail: "把两家公司的关键数字与证据放在一张页面", prompt: "对比 ORCL 和 MSFT 的资本开支压力" },
  { id: "watch", icon: BellRing, title: "跟踪规则", detail: "设定条件，满足时自动生成汇报", prompt: "ORCL 出现官方声明或跌破 130 美元时提醒我" },
  { id: "explain", icon: Calculator, title: "解释数字", detail: "拆解一个指标的口径与来源", prompt: "解释 ORCL 的 RPO 包含什么" },
] as const;

const SCOPES = [
  { id: "holdings", label: "全部持仓" },
  { id: "reports", label: "研究汇报" },
  { id: "custom", label: "自选标的" },
] as const;

type Scope = (typeof SCOPES)[number]["id"];

const noSubscribe = () => () => {};
const detectMac = () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function InstructionLauncher() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<Scope>("holdings");
  const [notice, setNotice] = useState(false);
  // Server render assumes macOS; the client corrects it without a hydration mismatch.
  const isMac = useSyncExternalStore(noSubscribe, detectMac, () => true);
  const launcher = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const noteId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setNotice(false);
    requestAnimationFrame(() => launcher.current?.focus());
  }, []);

  // ⌘K / Ctrl+K toggles the launcher from anywhere on Today.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(current => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  function trapFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); close(); return; }
    if (event.key !== "Tab" || !dialog.current) return;
    const focusable = dialog.current.querySelectorAll<HTMLElement>("button:not([disabled]), textarea, [href]");
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  function submit() {
    if (!text.trim()) { input.current?.focus(); return; }
    setNotice(true);
  }

  return (
    <>
      <button
        ref={launcher}
        type="button"
        className="instruction-launcher"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("下达指引")}
        onClick={() => setOpen(true)}
        hidden={open}
      >
        <span className="instruction-launcher-icon" aria-hidden="true"><Command /></span>
        <span className="instruction-launcher-label">{t("下达指引")}</span>
        <kbd aria-hidden="true">{isMac ? "⌘ K" : "Ctrl K"}</kbd>
      </button>

      {open && (
        <div className="instruction-layer">
          <div className="instruction-scrim" aria-hidden="true" onClick={close} />
          <div ref={dialog} className="instruction-palette" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={noteId} onKeyDown={trapFocus}>
            <div className="instruction-head">
              <h2 id={titleId}>{t("下达指引")}</h2>
              <button type="button" className="instruction-close" aria-label={t("关闭")} onClick={close}><X aria-hidden="true" /></button>
            </div>
            <label className="sr-only" htmlFor={`${titleId}-input`}>{t("描述你想看的页面")}</label>
            <textarea
              id={`${titleId}-input`}
              ref={input}
              className="instruction-input"
              rows={2}
              value={text}
              placeholder={t("描述你想看的页面，例如：帮我看看哪些持仓最需要我今天花时间复核")}
              onChange={event => { setText(event.target.value); setNotice(false); }}
              onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }}
            />

            <div className="instruction-scope" role="radiogroup" aria-label={t("范围")}>
              <span aria-hidden="true">{t("范围")}</span>
              {SCOPES.map(item => (
                <button key={item.id} type="button" role="radio" aria-checked={scope === item.id} className="instruction-chip" onClick={() => setScope(item.id)}>{t(item.label)}</button>
              ))}
            </div>

            <div className="instruction-templates">
              <p className="instruction-kicker">{t("它可以为你生成")}</p>
              <ul>
                {TEMPLATES.map(({ id, icon: Icon, title, detail, prompt }) => (
                  <li key={id}>
                    <button type="button" className="instruction-template" aria-pressed={text === t(prompt)} onClick={() => { setText(t(prompt)); setNotice(false); input.current?.focus(); }}>
                      <span className="instruction-template-icon" aria-hidden="true"><Icon /></span>
                      <span><strong>{t(title)}</strong><small>{t(detail)}</small></span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            <div className="instruction-foot">
              <p id={noteId} role="status">{notice ? t("页面生成即将上线，你的指引已保留在输入框。") : t("生成的是一张可操作的页面，不是对话。")}</p>
              <button type="button" className="sp-btn sp-btn-primary sp-btn-sm" onClick={submit} disabled={!text.trim()}>{t("生成页面")}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
