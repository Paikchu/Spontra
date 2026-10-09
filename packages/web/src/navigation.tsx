"use client";
import { createContext, useContext, type AnchorHTMLAttributes } from "react";
export type NavigationOptions = { scroll?: boolean };
export type NavigationState = {
  path: string; pendingPath: string | null; reportReturnPath: string | null;
  navigate: (href: string, options?: NavigationOptions) => void;
};
export const NavigationContext = createContext<NavigationState | null>(null);
export function useAppNavigation() {
  const context = useContext(NavigationContext);
  if (!context) throw new Error("App navigation provider is missing");
  return context;
}
export function useReportReturnPath() { return useContext(NavigationContext)?.reportReturnPath ?? null; }
/** Native links remain usable without JS; the host navigation intercepts internal clicks. */
export default function AppLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} />;
}
