import type { PublicBusinessFlow } from './business-flow.ts';
export type CompleteFlowReason = 'MISSING_TWO_QUARTERS'|'INCOMPARABLE_QUARTERS'|'MISSING_DISCLOSURE'|'INVALID_SOURCE'|'UNBALANCED_STATEMENT'|'UNSUPPORTED_INDUSTRY'|'SIGNED_LAYOUT_UNSUPPORTED'|'INVALID_PAYLOAD'|'LATEST_PERIOD_NOT_COLLECTED';
export type CompleteFlowCheck={complete:boolean;reasons:CompleteFlowReason[]};
export type CompleteFlowPublication={schemaVersion:'complete-business-flow.v1';status:'ready'|'preparing'|'unavailable';flow:PublicBusinessFlow|null;reasons:(CompleteFlowReason|'PREPARING'|'SOURCE_TEMPORARILY_UNAVAILABLE'|'DATA_POLICY_DENIED')[];outdated:boolean;lastAttemptAt:string|null};
export type FinancialIssuer={cik:string;tickers:string[];name:string;industry:'standard'|'financial'|'insurance'|'unknown'};
export type FinancialUniverse={schemaVersion:'financial-universe.v1';id:string;asOf:string;sourceUrl:string;issuers:FinancialIssuer[]};
