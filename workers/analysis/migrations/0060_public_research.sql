-- Public research is additive. Published bodies and provenance stay immutable in R2.
CREATE TABLE IF NOT EXISTS public_research_reports (
 report_id TEXT PRIMARY KEY, report_type TEXT NOT NULL CHECK(report_type IN ('macro','industry')),
 industry_id TEXT, current_version TEXT, freshness TEXT NOT NULL DEFAULT 'unavailable', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS public_research_versions (
 report_id TEXT NOT NULL, version TEXT NOT NULL, input_fingerprint TEXT NOT NULL, r2_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('draft','reviewing','reviewed','published','failed','withdrawn')),
 as_of TEXT NOT NULL, generated_at TEXT NOT NULL, valid_until TEXT NOT NULL, published_at TEXT, supersedes TEXT, review_json TEXT,
 summary_json TEXT NOT NULL, error TEXT, PRIMARY KEY(report_id,version),
 FOREIGN KEY(report_id) REFERENCES public_research_reports(report_id)
);
CREATE INDEX IF NOT EXISTS public_research_history ON public_research_versions(report_id,published_at);
CREATE TABLE IF NOT EXISTS public_research_dependencies (
 owner_id TEXT NOT NULL, owner_version TEXT NOT NULL, source_report_id TEXT NOT NULL, source_version TEXT NOT NULL,
 claim_id TEXT NOT NULL, owner_claim_id TEXT NOT NULL DEFAULT '*', ticker TEXT, status TEXT NOT NULL DEFAULT 'valid',
 PRIMARY KEY(owner_id,owner_version,source_report_id,source_version,claim_id,owner_claim_id)
);
CREATE INDEX IF NOT EXISTS public_research_dependency_source ON public_research_dependencies(source_report_id,source_version,claim_id);
CREATE TABLE IF NOT EXISTS company_research_exposures (
 exposure_id TEXT NOT NULL, version TEXT NOT NULL, company_id TEXT NOT NULL, industry_id TEXT NOT NULL,
 valid_from TEXT NOT NULL, valid_until TEXT, status TEXT NOT NULL, body_json TEXT NOT NULL,
 PRIMARY KEY(exposure_id,version)
);
CREATE INDEX IF NOT EXISTS company_research_exposure_company ON company_research_exposures(company_id,valid_from);
CREATE TABLE IF NOT EXISTS public_research_runs (
 run_id TEXT PRIMARY KEY, report_id TEXT NOT NULL, input_fingerprint TEXT NOT NULL,
 state TEXT NOT NULL, params_json TEXT NOT NULL, result_version TEXT, error TEXT,
 calls_reserved INTEGER NOT NULL DEFAULT 0, max_calls INTEGER NOT NULL, max_tokens INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(report_id,input_fingerprint)
);
CREATE TABLE IF NOT EXISTS company_research_contexts (
 result_id TEXT PRIMARY KEY, ticker TEXT NOT NULL, mapping_versions TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public_research_claims (
 report_id TEXT NOT NULL, version TEXT NOT NULL, claim_id TEXT NOT NULL,
 PRIMARY KEY(report_id,version,claim_id)
);
CREATE TABLE IF NOT EXISTS public_research_claim_invalidations (
 report_id TEXT NOT NULL, version TEXT NOT NULL, claim_id TEXT NOT NULL,
 PRIMARY KEY(report_id,version,claim_id)
);
-- An adoption is checked inside the consuming publication's transaction, not only during model execution.
CREATE TABLE IF NOT EXISTS public_research_adoption_checks (
 result_id TEXT NOT NULL, report_id TEXT NOT NULL, version TEXT NOT NULL, claim_id TEXT NOT NULL,
 valid INTEGER NOT NULL CHECK(valid=1), PRIMARY KEY(result_id,report_id,version,claim_id)
);
