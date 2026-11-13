-- One README per filing (accession): the library's non-boilerplate passages plus the
-- filing's own exhibits, with each passage's period. The text lives in R2; this row is the pointer.
CREATE TABLE sec_filing_readmes (
  ticker TEXT NOT NULL,
  accession_number TEXT NOT NULL,
  form TEXT NOT NULL,
  report_date TEXT NOT NULL DEFAULT '',
  filed_at TEXT NOT NULL DEFAULT '',
  r2_key TEXT NOT NULL,
  chars INTEGER NOT NULL,
  passages INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  prepared_at TEXT NOT NULL,
  PRIMARY KEY (ticker, accession_number)
);
CREATE INDEX sec_filing_readmes_ticker ON sec_filing_readmes(ticker, filed_at);
