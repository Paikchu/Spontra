import { sha256 } from "../sha256.ts";

/** A retrieval timestamp is not a source revision. Whitespace-only changes do not revise the evidence. */
export const publicSourceRevision = (text: string): Promise<string> => sha256(text.replace(/\s+/g, " ").trim());
