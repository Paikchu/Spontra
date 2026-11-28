export type TranscriptStatus = 'queued' | 'fetching' | 'ready' | 'unavailable' | 'needs_period' | 'retry';
export type TranscriptItem = {
  id: string; ticker: string; periodEnd: string; accession: string; filingUrl: string; filedAt: string;
  fiscalYear: number | null; fiscalQuarter: number | null; status: TranscriptStatus;
  title: string | null; sourceUrl: string | null; characters: number; errorCode: string | null;
  fetchedAt: string | null; nextAttemptAt: string; updatedAt: string;
};
export type TranscriptList = { transcripts: TranscriptItem[]; companies: string[]; total: number; offset: number; enabled: boolean };
export type TranscriptDetail = TranscriptItem & { content: string | null };
