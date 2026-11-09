/**
 * When a run's next wake is due. Alarms of one Durable Object do not overlap, so a wake that finds the previous one still
 * marked busy is normally looking at an invocation the platform cancelled before its `finally` ran.
 */
/** Longer than a wake is ever expected to overlap the one before it. */
export const BUSY_STALE_MS = 60_000;
/** How soon a wake that found the run busy looks again, so a dead invocation cannot leave the run with no wake at all. */
export const BUSY_RECHECK_MS = 30_000;
/** A scheduled wake this far overdue did not fire. */
const OVERDUE_MS = 60_000;

export const isBusy = (busySince: number, now: number) => busySince > 0 && now - busySince < BUSY_STALE_MS;

/** Whether a run that is not finished has lost its wake: none is pending, or the pending one never fired. */
export const lostWake = (wakeAt: number | null, now: number) => wakeAt === null || now - wakeAt > OVERDUE_MS;
