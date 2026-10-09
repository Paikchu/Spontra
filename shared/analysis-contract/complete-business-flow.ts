import type { PublicBusinessFlow } from './business-flow.ts';
import type { RevenueHistory } from './revenue-history.ts';
export type CompleteFlowReason = 'MISSING_TWO_QUARTERS'|'INCOMPARABLE_QUARTERS'|'MISSING_DISCLOSURE'|'INVALID_SOURCE'|'UNBALANCED_STATEMENT'|'UNSUPPORTED_INDUSTRY'|'SIGNED_LAYOUT_UNSUPPORTED'|'INVALID_PAYLOAD'|'LATEST_PERIOD_NOT_COLLECTED'|'RESTATEMENT_REVIEW_REQUIRED';
export type CompleteFlowCheck={complete:boolean;reasons:CompleteFlowReason[]};
export type CompleteFlowPublication={schemaVersion:'complete-business-flow.v1';status:'ready'|'preparing'|'unavailable';flow:PublicBusinessFlow|null;reasons:(CompleteFlowReason|'PREPARING'|'SOURCE_TEMPORARILY_UNAVAILABLE'|'DATA_POLICY_DENIED')[];outdated:boolean;lastAttemptAt:string|null;
 /** Supplementary quarterly revenue by business; absent or null when not yet collected. */
 history?:RevenueHistory|null;
 /** Independently audited quarterly statements from the last two years; latest pair remains the publication gate. */
 reports?:PublicBusinessFlow|null};
export type FinancialIssuer={cik:string;tickers:string[];name:string;industry:'standard'|'financial'|'insurance'|'unknown'};
