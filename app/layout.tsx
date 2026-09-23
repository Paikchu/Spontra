import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";
import "./daily-reports-home.css";
import "./analysis/earning-report.css";
import "@/components/earning-report/report-blocks/report-content.css";
import "katex/dist/katex.min.css";
import "./spontra-ui.css";
import { AppNavigation } from "./app-navigation";
import { LanguageProvider } from "./language-provider";
import { ThemeProvider } from "./theme-control";
import { themeScript } from "@/lib/theme-script";
import { NavigationDock } from "@/components/navigation-dock";
import { SpontraEffects } from "@/components/spontra/effects";

export const viewport: Viewport = {
  themeColor: "#0d1718",
  colorScheme: "light dark",
  viewportFit: "cover",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const imageUrl = `${protocol}://${host}/og.png`;

  return {
    title: "Spontra",
    description: "个人投资研究与 Agent 汇报：跟进买入理由，核验变化，积累有据可查的研究记录。",
    icons: {
      icon: [{ url: "/spontra-icon.svg", type: "image/svg+xml" }, { url: "/favicon-32.png", sizes: "32x32", type: "image/png" }],
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    },
    openGraph: {
      title: "Spontra",
      description: "个人投资研究与 Agent 汇报：跟进买入理由，核验变化，积累有据可查的研究记录。",
      type: "website",
      locale: "zh_CN",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "投资组合当前净值" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Spontra",
      description: "个人投资研究与 Agent 汇报：跟进买入理由，核验变化，积累有据可查的研究记录。",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head><link rel="preload" href="/fonts/Geist-Variable.woff2" as="font" type="font/woff2" crossOrigin="anonymous" /><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body><ThemeProvider><LanguageProvider><AppNavigation dock={<NavigationDock />}>{children}</AppNavigation></LanguageProvider></ThemeProvider><SpontraEffects /></body>
    </html>
  );
}
