/** The admin's view of the stage (docs/stage-agent-design.md §3.6): today's spend against the caps and recent conversations. */
export type StageAdmin = {
  /** Today's units against the global caps, by allowance. */
  today: Array<{ feature: string; units: number; cap: number | null }>;
  /** Today's model calls and tokens for the stage, from the cost ledger. */
  usage: { calls: number; inputTokens: number; outputTokens: number };
  conversations: Array<{ id: string; reader: string; ticker: string; createdAt: string; lastAt: string; turns: number; status: string }>;
};
