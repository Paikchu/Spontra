export const DAY_MS = 86_400_000;
/** Days from one ISO date (or instant) to another; negative when `end` comes first. */
export const daysBetween = (start: string, end: string): number => (Date.parse(end) - Date.parse(start)) / DAY_MS;
