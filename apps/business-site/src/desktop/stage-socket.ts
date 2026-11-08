import { invoke } from "@tauri-apps/api/core";

declare const __SPONTRA_SITE_HOST__: string;

/** A socket cannot carry the reader's cookie across origins, so the desktop app names the reader in the address. */
export const stageSocketOptions: { host?: string; query?: () => Promise<Record<string, string>>; queryDeps?: unknown[] } = {
  host: __SPONTRA_SITE_HOST__,
  query: async () => {
    const reader = await invoke<string | null>("reader_token");
    return reader ? { reader } : ({} as Record<string, string>);
  },
  queryDeps: [],
};
