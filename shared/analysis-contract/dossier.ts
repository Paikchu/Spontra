import type { FindingMaterial } from "./findings.ts";
import type { LensDocument } from "./lens.ts";

/**
 * What the analyst agent adds to a findings publication: a lens document per finding, composed from the
 * company's own filings, figures and peers, and the materials those documents quote. It is bound to the
 * findings publication it was written for by that publication's fingerprint; when the findings move on,
 * the dossier waits for the next run and the page shows the findings' own documents meanwhile.
 */
export type DossierPublication = {
  schemaVersion: "dossier.v1";
  ticker: string;
  /** Fingerprint of the findings publication the documents were written for. */
  findingsFingerprint: string;
  /** The analyst's own input state (prompt version, findings, newest filings); the sweep reruns when it changes. */
  fingerprint: string;
  generatedAt: string;
  model: string;
  documents: Record<string, LensDocument>;
  materials: FindingMaterial[];
};
