/** How the stage socket connects. The site connects to its own origin; the desktop build replaces this module. */
export const stageSocketOptions: { host?: string; query?: () => Promise<Record<string, string>>; queryDeps?: unknown[] } = {};
