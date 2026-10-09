"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one failing block from taking the report with it.
 *
 * This is the last of the layers, not the main one: validation already dropped what could not be
 * rendered, so anything reaching here is a defect in a renderer rather than bad model output. It
 * covers the interactive blocks — the chart runs on the client, where a bad series can throw long
 * after the page was served — while a server-rendered block's failure is caught by the route's
 * error boundary instead.
 */
export class ReportBlockBoundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`report block failed: ${this.props.label}`, error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <p className="report-block report-block-empty">{this.props.label}：该模块无法显示，请回到 SEC 原文核对。</p>;
  }
}
