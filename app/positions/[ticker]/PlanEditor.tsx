"use client";

import { useLanguage } from "@/app/language-provider";

import { useEffect, useRef, useState } from "react";
import type { HoldingPlanRecord } from "@/lib/holding-plan-store";
import type { PlanAction } from "@/lib/holding-plan";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select";
import { Empty, EmptyHeader, EmptyDescription } from "@/components/ui/empty";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PlusIcon, ArrowUpIcon, ArrowDownIcon, Trash2Icon, LoaderCircleIcon } from "lucide-react";

type EditableLevel = {
  id: string;
  action: PlanAction;
  price: string;
  sizeNote: string;
  triggerNote: string;
};

const ACTION_LABELS: Record<PlanAction, string> = {
  add: "加仓",
  reduce: "减仓",
  stop: "止损",
  target: "目标",
};

function canAutoSave(draft: { holdingReason: string; levels: EditableLevel[] }): boolean {
  return Boolean(draft.holdingReason.trim()) && draft.levels.every((level) => {
    const price = Number(level.price);
    return Number.isFinite(price) && price > 0;
  });
}

export type PositionPlanStatus = "ready" | "loading" | "unavailable";

export function PlanEditor({
  ticker,
  initialPlan,
  unavailable = false,
  onDirtyChange,
}: {
  ticker: string;
  initialPlan: HoldingPlanRecord | null;
  unavailable?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { t } = useLanguage();
  const [holdingReason, setHoldingReason] = useState(initialPlan?.holdingReason ?? "");
  const [levels, setLevels] = useState<EditableLevel[]>(() => initialPlan?.levels.map((level) => ({
    id: level.id,
    action: level.action,
    price: (level.priceCents / 100).toFixed(2),
    sizeNote: level.sizeNote,
    triggerNote: level.triggerNote,
  })) ?? []);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState(unavailable ? "计划数据暂时无法读取，请稍后再试。" : "");
  const [dirty, setDirty] = useState(false);
  const draftRef = useRef({ holdingReason, levels });
  const editVersionRef = useRef(0);
  const savingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveRef = useRef<((automatic: boolean) => Promise<void>) | undefined>(undefined);

  const markDirty = () => {
    editVersionRef.current += 1;
    setDirty(true);
    setStatus("idle");
    setMessage("");
    onDirtyChange?.(true);
  };

  const addLevel = () => {
    if (levels.length >= 20) return;
    setLevels((current) => [...current, { id: crypto.randomUUID(), action: "add", price: "", sizeNote: "", triggerNote: "" }]);
    markDirty();
  };

  const updateLevel = (id: string, patch: Partial<EditableLevel>) => {
    setLevels((current) => current.map((level) => level.id === id ? { ...level, ...patch } : level));
    markDirty();
  };

  const moveLevel = (index: number, offset: number) => {
    const destination = index + offset;
    if (destination < 0 || destination >= levels.length) return;
    setLevels((current) => {
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
    markDirty();
  };

  const removeLevel = (id: string) => {
    setLevels((current) => current.filter((item) => item.id !== id));
    markDirty();
  };

  useEffect(() => {
    draftRef.current = { holdingReason, levels };
    saveRef.current = async (automatic) => {
      if (unavailable || savingRef.current) return;
      const version = editVersionRef.current;
      const draft = draftRef.current;
      if (automatic && !canAutoSave(draft)) return;
      savingRef.current = true;
      setStatus("saving");
      setMessage(automatic ? "自动保存中…" : "");
      const payload = {
        holdingReason: draft.holdingReason,
        levels: draft.levels.map((level, sortOrder) => ({
          id: level.id,
          action: level.action,
          priceCents: Math.round(Number(level.price) * 100),
          sizeNote: level.sizeNote,
          triggerNote: level.triggerNote,
          sortOrder,
        })),
      };
      try {
        const response = await fetch(`/api/plans/${encodeURIComponent(ticker)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const result = await response.json() as { error?: string };
        if (!response.ok) throw new Error(result.error ?? "计划保存失败。");
        if (version === editVersionRef.current) {
          setStatus("saved");
          setMessage(automatic ? "已自动保存" : "计划已保存");
          setDirty(false);
          onDirtyChange?.(false);
        } else {
          setStatus("idle");
          setMessage("有新的更改待保存");
        }
      } catch (error) {
        setStatus("error");
        setMessage(error instanceof Error ? error.message : "计划保存失败。");
      } finally {
        savingRef.current = false;
        if (version !== editVersionRef.current && !unavailable) {
          saveTimerRef.current = setTimeout(() => {
            saveTimerRef.current = null;
            void saveRef.current?.(true);
          }, 700);
        }
      }
    };
  }, [holdingReason, levels, onDirtyChange, ticker, unavailable]);

  useEffect(() => {
    if (!dirty || unavailable || !canAutoSave({ holdingReason, levels })) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void saveRef.current?.(true);
    }, 700);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    };
  }, [dirty, holdingReason, levels, unavailable]);

  useEffect(() => () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, []);

  return (
    <section className="plan-editor" id="plan-editor" aria-label={t("持仓计划")}>
      {message && status !== "error" && !unavailable && <p className="text-sm text-muted-foreground" role="status">{t(message)}</p>}
      {(status === "error" || unavailable) && <Alert variant="destructive" className="mt-4"><AlertDescription>{t(message)}</AlertDescription></Alert>}
      <p className="mt-2 text-sm text-muted-foreground">共享计划保存在服务器，所有访问者均可编辑，以最后一次保存为准。</p>
      <FieldGroup className="mt-5">
        <Field data-disabled={unavailable}>
          <FieldLabel htmlFor="holding-reason">{t("持仓原因")}</FieldLabel>
          <Textarea id="holding-reason" value={holdingReason} onChange={(event) => { setHoldingReason(event.target.value); markDirty(); }} placeholder={t("为什么持有它？什么事实支持这个判断？")} maxLength={5_000} rows={6} className="min-h-36" disabled={unavailable} />
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap items-center justify-between gap-3 mt-8 mb-4">
        <div><h3 className="font-medium">{t("规划点位")}</h3><p className="text-sm text-muted-foreground mt-1">{t("把价格、动作和触发条件写在决策发生之前。")}</p></div>
        <Button variant="outline" type="button" onClick={addLevel} disabled={unavailable || levels.length >= 20}><PlusIcon data-icon="inline-start" />{t("添加点位")}</Button>
      </div>
      <div className="flex flex-col gap-4">
        {levels.map((level, index) => (
          <article className="rounded-xl border border-border bg-card p-4" key={level.id} aria-label={`第 ${index + 1} 条点位`}>
            <div className="flex items-center justify-between gap-3 mb-4">
              <span className="text-sm text-muted-foreground">{t("点位 ")}{String(index + 1).padStart(2, "0")}</span>
              <div className="flex gap-1">
                <Button variant="ghost" size="icon" type="button" onClick={() => moveLevel(index, -1)} disabled={unavailable || index === 0} aria-label={`上移第 ${index + 1} 条点位`}><ArrowUpIcon /></Button>
                <Button variant="ghost" size="icon" type="button" onClick={() => moveLevel(index, 1)} disabled={unavailable || index === levels.length - 1} aria-label={`下移第 ${index + 1} 条点位`}><ArrowDownIcon /></Button>
                <Button variant="destructive" size="icon" type="button" onClick={() => removeLevel(level.id)} disabled={unavailable} aria-label={`删除第 ${index + 1} 条点位`}><Trash2Icon /></Button>
              </div>
            </div>
            <FieldGroup className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <Field data-disabled={unavailable}><FieldLabel htmlFor={`action-${level.id}`}>{t("动作")}</FieldLabel>
                <Select value={level.action} onValueChange={(value) => updateLevel(level.id, {action:value as PlanAction})} disabled={unavailable}>
                  <SelectTrigger id={`action-${level.id}`} className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectGroup>{Object.entries(ACTION_LABELS).map(([value,label]) => <SelectItem key={value} value={value}>{t(label)}</SelectItem>)}</SelectGroup></SelectContent>
                </Select>
              </Field>
              <Field data-disabled={unavailable}><FieldLabel htmlFor={`price-${level.id}`}>{t("目标价格")}</FieldLabel><InputGroup><InputGroupAddon>$</InputGroupAddon><InputGroupInput id={`price-${level.id}`} value={level.price} onChange={(event) => updateLevel(level.id, {price:event.target.value})} inputMode="decimal" placeholder="0.00" disabled={unavailable} /></InputGroup></Field>
              <Field data-disabled={unavailable}><FieldLabel htmlFor={`size-${level.id}`}>{t("执行规模")}</FieldLabel><Input id={`size-${level.id}`} value={level.sizeNote} onChange={(event) => updateLevel(level.id, {sizeNote:event.target.value})} placeholder={t("20 股 / 目标 8%")} maxLength={200} disabled={unavailable} /></Field>
              <Field data-disabled={unavailable}><FieldLabel htmlFor={`trigger-${level.id}`}>{t("触发条件")}</FieldLabel><Input id={`trigger-${level.id}`} value={level.triggerNote} onChange={(event) => updateLevel(level.id, {triggerNote:event.target.value})} placeholder={t("估值回落且基本面未变")} maxLength={500} disabled={unavailable} /></Field>
            </FieldGroup>
          </article>
        ))}
        {levels.length === 0 && <Empty><EmptyHeader><EmptyDescription>{t("尚未设置点位。可以先保存持仓原因，再逐步补充。")}</EmptyDescription></EmptyHeader></Empty>}
      </div>
      <div className="flex items-center justify-between gap-4 mt-5">
        <span className="text-xs text-muted-foreground">{holdingReason.length.toLocaleString("zh-CN")} / 5,000</span>
        <Button type="button" onClick={() => void saveRef.current?.(false)} disabled={unavailable || status === "saving"}>{status === "saving" && <LoaderCircleIcon data-icon="inline-start" className="animate-spin" />}{status === "saving" ? t("保存中…") : t("立即保存")}</Button>
      </div>
    </section>
  );
}
