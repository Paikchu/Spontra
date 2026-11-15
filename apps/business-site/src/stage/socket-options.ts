/** How the stage socket connects. The site connects to its own origin. */
export const stageSocketOptions: { host?: string; query?: () => Promise<Record<string, string>>; queryDeps?: unknown[] } = {};
