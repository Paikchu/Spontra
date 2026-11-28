-- Insider trading by person: one row per Form 4 transaction line, keyed by filing and line so re-reading a filing
-- rewrites the same rows, and one row per reporting owner per company with the aggregates the page lists.
-- Only filings whose issuer is the company are recorded (B1): a company's own submission list also carries the
-- Form 4s it filed as a holder of other companies' stock, and those never enter here.
CREATE TABLE insider_transactions (
 ticker TEXT NOT NULL,
 issuer_cik TEXT NOT NULL,
 accession TEXT NOT NULL,
 line_no INTEGER NOT NULL,
 form TEXT NOT NULL CHECK (form IN ('4', '4/A')),
 -- The reporting owner CIK, or 'name:<normalized name>' when the filing gives none.
 owner_key TEXT NOT NULL,
 owner_cik TEXT,
 owner_name TEXT NOT NULL,
 transaction_date TEXT NOT NULL,
 filed_at TEXT NOT NULL,
 code TEXT NOT NULL,
 acquired_disposed TEXT NOT NULL CHECK (acquired_disposed IN ('A', 'D')),
 side TEXT NOT NULL CHECK (side IN ('buy', 'sell', 'other')),
 shares REAL NOT NULL,
 price REAL,
 value REAL,
 owned_after REAL,
 ownership TEXT NOT NULL CHECK (ownership IN ('D', 'I')),
 derivative INTEGER NOT NULL CHECK (derivative IN (0, 1)),
 security_title TEXT NOT NULL,
 planned INTEGER NOT NULL CHECK (planned IN (0, 1)),
 title TEXT,
 is_director INTEGER NOT NULL CHECK (is_director IN (0, 1)),
 is_officer INTEGER NOT NULL CHECK (is_officer IN (0, 1)),
 is_ten_percent_owner INTEGER NOT NULL CHECK (is_ten_percent_owner IN (0, 1)),
 filing_url TEXT NOT NULL,
 index_url TEXT NOT NULL,
 -- When the ledger first recorded the line; kept on re-ingestion, so a re-read never looks new again.
 first_seen_at TEXT NOT NULL,
 ingested_at TEXT NOT NULL,
 PRIMARY KEY (ticker, accession, line_no)
);
CREATE INDEX insider_transactions_person ON insider_transactions(ticker, owner_key, transaction_date DESC, filed_at DESC, accession DESC, line_no DESC);
CREATE INDEX insider_transactions_company ON insider_transactions(ticker, transaction_date DESC);

CREATE TABLE insider_persons (
 ticker TEXT NOT NULL,
 owner_key TEXT NOT NULL,
 issuer_cik TEXT NOT NULL,
 owner_cik TEXT,
 name TEXT NOT NULL,
 title TEXT,
 is_director INTEGER NOT NULL CHECK (is_director IN (0, 1)),
 is_officer INTEGER NOT NULL CHECK (is_officer IN (0, 1)),
 is_ten_percent_owner INTEGER NOT NULL CHECK (is_ten_percent_owner IN (0, 1)),
 first_trade_at TEXT,
 last_trade_at TEXT,
 last_new_trade_at TEXT,
 -- The person's latest line, as the list shows it (the insider-transactions row shape, JSON).
 latest_json TEXT,
 sold_shares REAL NOT NULL DEFAULT 0,
 sold_value REAL NOT NULL DEFAULT 0,
 sell_count INTEGER NOT NULL DEFAULT 0,
 bought_shares REAL NOT NULL DEFAULT 0,
 bought_value REAL NOT NULL DEFAULT 0,
 buy_count INTEGER NOT NULL DEFAULT 0,
 net_shares REAL NOT NULL DEFAULT 0,
 net_value REAL NOT NULL DEFAULT 0,
 transaction_count INTEGER NOT NULL DEFAULT 0,
 filing_count INTEGER NOT NULL DEFAULT 0,
 held_after REAL,
 planned INTEGER NOT NULL DEFAULT 0 CHECK (planned IN (0, 1)),
 updated_at TEXT NOT NULL,
 PRIMARY KEY (ticker, owner_key)
);
CREATE INDEX insider_persons_latest ON insider_persons(ticker, last_trade_at DESC);
