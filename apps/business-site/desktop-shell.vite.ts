import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/** The published site the desktop app reads from; `SPONTRA_SITE_ORIGIN` points a build at another one. */
export const DEFAULT_SITE_ORIGIN = "https://spontra-business-map.max-zhangyuchen.workers.dev";

const INSIGHTS = /^https:\/\/(?:static\.)?cloudflareinsights\.com$/;
const APP_ORIGINS = ["tauri:", "http://tauri.localhost"];

/** Each path's Content-Security-Policy in a Cloudflare `_headers` file. */
export function readHeaderPolicies(headers: string): Map<string, string> {
  const policies = new Map<string, string>();
  let path = "";
  for (const line of headers.split("\n")) {
    if (line.startsWith("#") || !line.trim()) continue;
    if (!/^\s/.test(line)) { path = line.trim(); continue; }
    const value = /^\s+Content-Security-Policy:\s*(.+)$/.exec(line)?.[1];
    if (value) policies.set(path, value.trim());
  }
  return policies;
}

type Directives = Map<string, string[]>;
const parse = (policy: string): Directives => new Map(policy.split(";").map(part => part.trim().split(/\s+/)).filter(tokens => tokens[0]).map(tokens => [tokens[0]!, tokens.slice(1)]));
const print = (directives: Directives) => [...directives].map(([name, values]) => [name, ...values].join(" ")).join("; ");

/** `frame-ancestors` is ignored in a meta policy, and the desktop app has no analytics beacon. */
function forMeta(policy: string): Directives {
  const directives = parse(policy);
  directives.delete("frame-ancestors");
  for (const [name, values] of directives) directives.set(name, values.filter(value => !INSIGHTS.test(value)));
  return directives;
}

/** A page's policy as the desktop app needs it: the site's own, with the proxy and the stage socket in place of the network. */
export function desktopPolicy(policy: string, siteOrigin: string): string {
  const directives = forMeta(policy);
  const socket = siteOrigin.replace(/^http/, "ws");
  directives.set("connect-src", ["'self'", "ipc:", "http://ipc.localhost", "spontra-api://localhost", "http://spontra-api.localhost", socket]);
  directives.set("img-src", [...(directives.get("img-src") ?? []), "blob:"]);
  return print(directives);
}

/** The picture frame runs at an opaque origin, so the page's fonts are named by the app's own origins. */
export function pictureFramePolicy(policy: string): string {
  const directives = forMeta(policy);
  directives.set("font-src", [...(directives.get("font-src") ?? []), ...APP_ORIGINS]);
  return print(directives);
}

const meta = (policy: string) => `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', "&quot;")}">`;
const afterCharset = (html: string, tag: string) => html.replace(/<meta charset="UTF-8">/, match => match + tag);

/** The desktop build: the boot script ahead of the page's own, the site's security headers as meta tags, and the desktop transport in the stage. */
export function desktopShell(siteOrigin: string): Plugin {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const policies = readHeaderPolicies(readFileSync(join(root, "public/_headers"), "utf8"));
  const policyOf = (path: string) => {
    const policy = policies.get(path);
    if (!policy) throw new Error(`public/_headers has no policy for ${path}`);
    return policy;
  };
  let building = false;
  let outDir = "";
  return {
    name: "spontra-desktop-shell",
    configResolved(config) { building = config.command === "build"; outDir = join(config.root, config.build.outDir); },
    transformIndexHtml: {
      order: "pre",
      handler(html, context) {
        if (context.path.endsWith("/lens-frame.html")) return building ? afterCharset(html, meta(print(forMeta(policyOf("/lens-frame"))))) : html;
        const booted = html.replace('<script type="module" src="/src/main.tsx">', '<script type="module" src="/src/desktop/boot.ts"></script><script type="module" src="/src/main.tsx">');
        return building ? afterCharset(booted, meta(desktopPolicy(policyOf("/*"), siteOrigin))) : booted;
      },
    },
    closeBundle() {
      if (!building) return;
      const file = join(outDir, "html-frame.html");
      writeFileSync(file, afterCharset(readFileSync(file, "utf8"), meta(pictureFramePolicy(policyOf("/html-frame")))));
    },
  };
}
