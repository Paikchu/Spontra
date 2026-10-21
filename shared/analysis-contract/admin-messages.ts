import type { Feature } from './business-features.ts';

/**
 * One entry of the admin's inbox: a company's feature finished a run. Runs with the same outcome fold into one entry
 * while it is unread (`count`). A failed entry means the feature's switch was turned off for the company.
 */
export type AdminMessage = {
  id: string; ticker: string; feature: Feature; outcome: 'succeeded' | 'failed';
  /** The failure, or what was published (an event name, a form and accession). */
  detail: string | null;
  count: number; createdAt: string; updatedAt: string; readAt: string | null;
};
export type AdminMessages = { messages: AdminMessage[]; unread: number };
