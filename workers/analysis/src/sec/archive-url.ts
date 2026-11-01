/** An accession's archive directory, without a trailing slash. CIKs in archive paths are unpadded. */
export function secArchiveRoot(cikNumber: number, accessionNumber: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cikNumber}/${accessionNumber.replaceAll("-", "")}`;
}

/** Join a primary document (including rendering subdirectories), accepting its accession prefix once. */
export function secArchiveDocumentUrl(archiveRoot: string, primaryDocument: string): string {
  const accession = /\/(\d+)$/.exec(archiveRoot)?.[1];
  const relative = accession && primaryDocument.startsWith(`${accession}/`)
    ? primaryDocument.slice(accession.length + 1) : primaryDocument;
  // Keep the caller's encoding and suffix intact; URL resolution would reinterpret relative paths.
  return `${archiveRoot}/${relative}`;
}

/** Split at the accession boundary, rather than guessing from the last one or two slashes. */
export function parseSecArchiveDocumentUrl(documentUrl: string): { archiveRoot: string; primaryDocument: string } {
  const match = /^(https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+)\/(.+)$/.exec(documentUrl);
  if (!match) throw new Error("Invalid SEC archive document URL");
  return { archiveRoot: match[1], primaryDocument: match[2] };
}
