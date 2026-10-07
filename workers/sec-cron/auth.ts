import { timingSafeEqual } from "node:crypto";

export function matchesSecret(supplied: string | null, expected: string | undefined): boolean {
  if (!expected || !supplied) return false;
  const left = new TextEncoder().encode(supplied);
  const right = new TextEncoder().encode(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type PortfolioReadCredentials = { PORTFOLIO_READ_TOKEN?: string; PORTFOLIO_SITE_READ_TOKEN?: string };

export function matchesPortfolioReadToken(supplied: string | null, env: PortfolioReadCredentials): boolean {
  return matchesSecret(supplied, env.PORTFOLIO_READ_TOKEN) || matchesSecret(supplied, env.PORTFOLIO_SITE_READ_TOKEN);
}
