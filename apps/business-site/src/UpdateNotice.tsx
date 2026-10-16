import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/packages/web/src/ui/button";
import { messages } from "@/packages/web/src/i18n";
import type { PendingUpdate, UpdateNews } from "./live-company";

const m = messages({
  findings: "New findings", reports: "New report", events: "New events", data: "Data updated", update: "Update", dismiss: "Dismiss",
}, {
  findings: "新要点", reports: "新财报", events: "新事件", data: "数据有更新", update: "更新", dismiss: "关闭",
});

const LABEL: Record<UpdateNews, string> = { findings: m.findings, reports: m.reports, events: m.events };

/** A newer read is loaded: says what it brings and waits for the reader to take it. */
export function UpdateNotice({ update, onApply, onDismiss }: { update: PendingUpdate | null; onApply: () => void; onDismiss: () => void }) {
  const reduced = useReducedMotion();
  return <AnimatePresence>
    {update && <motion.div key="update" className="update-notice" role="status"
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -14, scale: .96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={reduced ? { opacity: 0 } : { opacity: 0, y: -10, scale: .97 }}
      transition={{ type: "spring", stiffness: 420, damping: 32 }}>
      <i className="update-dot" aria-hidden="true" />
      <span className="update-text">{update.news.length ? update.news.map(n => LABEL[n]).join(" · ") : m.data}</span>
      <Button variant="unstyled" type="button" className="update-apply" onClick={onApply}>{m.update}</Button>
      <Button variant="unstyled" type="button" className="icon-button update-dismiss" aria-label={m.dismiss} title={m.dismiss} onClick={onDismiss}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg>
      </Button>
    </motion.div>}
  </AnimatePresence>;
}
