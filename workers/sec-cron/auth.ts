import { timingSafeEqual } from "node:crypto";

export function matchesSecret(supplied: string | null, expected: string | undefined): boolean {
  if (!expected || !supplied) return false;
  const left = new TextEncoder().encode(supplied);
  const right = new TextEncoder().encode(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
