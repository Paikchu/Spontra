"use client";
import { ADMIN_SITE_ORIGIN } from "@/shared/admin-site";
import { platformKind } from "@/packages/client/src/platform";

import { Sun, Moon, Monitor, ShieldCheck, ArrowUpRight } from "lucide-react";
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card";
import { FieldGroup, Field, FieldLabel, FieldDescription, FieldSeparator } from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useTheme } from "../theme-control";
import { useLanguage } from "../language-provider";

export default function SettingsPage() {
  const { mode, choose } = useTheme();
  const { language, chooseLanguage, t } = useLanguage();
  return <main className="settings-page" aria-labelledby="settings-title">
    <h1 id="settings-title">{t("设置")}</h1>
    <Card>
      <CardHeader><CardTitle>{t("外观与语言")}</CardTitle><CardDescription>{t("按你的习惯调整显示方式。")}</CardDescription></CardHeader>
      <CardContent><FieldGroup>
        <Field>
          <FieldLabel id="theme-label">{t("主题")}</FieldLabel>
          <ToggleGroup type="single" variant="outline" value={mode} onValueChange={choose} aria-labelledby="theme-label" className="theme-options">
            <ToggleGroupItem value="light" className="theme-option"><span className="theme-thumb" data-thumb="paper" aria-hidden="true"><i /><b /></span><span className="theme-option-label"><Sun />{t("日间模式")}</span></ToggleGroupItem>
            <ToggleGroupItem value="dark" className="theme-option"><span className="theme-thumb" data-thumb="ink" aria-hidden="true"><i /><b /></span><span className="theme-option-label"><Moon />{t("夜间模式")}</span></ToggleGroupItem>
            <ToggleGroupItem value="system" className="theme-option"><span className="theme-thumb" data-thumb="system" aria-hidden="true"><i /><b /></span><span className="theme-option-label"><Monitor />{t("跟随系统")}</span></ToggleGroupItem>
          </ToggleGroup>
        </Field>
        <FieldSeparator />
        <Field>
          <FieldLabel id="language-label">{t("语言")}</FieldLabel>
          <ToggleGroup type="single" variant="outline" value={language} onValueChange={chooseLanguage} aria-labelledby="language-label">
            <ToggleGroupItem value="zh-CN" lang="zh-CN">中文</ToggleGroupItem>
            <ToggleGroupItem value="en" lang="en">English</ToggleGroupItem>
          </ToggleGroup>
          <FieldDescription>{t("研究正文与自行填写的内容保留原文。")}</FieldDescription>
        </Field>
      </FieldGroup></CardContent>
      <CardFooter><p className="text-muted-foreground" role="status">{platformKind() === "desktop" ? (language === "en" ? "Changes apply immediately and are saved on this device." : "更改即时生效，并保存在此设备。") : t("更改即时生效，并保存在此浏览器。")}</p></CardFooter>
    </Card>
    {platformKind() !== "desktop" && <Card><CardHeader><CardTitle>财报管理后台</CardTitle><CardDescription>检查线上财报报告，查看生成进度并重新生成分析。</CardDescription></CardHeader><CardContent><a href={`${ADMIN_SITE_ORIGIN}/admin/reports`} className="inline-flex items-center gap-2"><ShieldCheck size={17} />打开管理看板<ArrowUpRight size={15} /></a></CardContent></Card>}
  </main>;
}
