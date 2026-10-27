import { useRef } from "react";
import { messages } from "@/packages/web/src/i18n";

const m = messages({
  notice: "We collect anonymous usage stats only. No cookies.",
  title: "Anonymous usage stats",
  body: "We collect the page path, feature events, and a random session id. We do not store IP addresses, we do not use cookies, and we respect DNT and GPC.",
  close: "Close",
}, {
  notice: "我们只收集匿名使用统计，不用 Cookie",
  title: "匿名使用统计",
  body: "仅收集页面路径、功能交互事件和随机会话 ID。不保存 IP，不用 Cookie，并遵守 DNT 与 GPC。",
  close: "关闭",
});

/** The footer line. Opening it explains what the anonymous events contain. */
export function PrivacyNote() {
  const ref = useRef<HTMLDialogElement>(null);
  return <>
    <button type="button" className="privacy-note" onClick={() => ref.current?.showModal()}>{m.notice}</button>
    <dialog ref={ref} className="privacy-dialog" aria-labelledby="privacy-title" onClick={event => { if (event.target === event.currentTarget) ref.current?.close(); }}>
      <h2 id="privacy-title">{m.title}</h2>
      <p>{m.body}</p>
      <form method="dialog"><button type="submit" className="privacy-close">{m.close}</button></form>
    </dialog>
  </>;
}
