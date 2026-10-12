-- Business links are settled without a person (docs/sec-filing-library.md, P5): an independent review either agrees
-- with the proposed category, and the link is `verified`, or not, and the link is `disputed` with no category. The
-- review records both judgments and the sections the reviewer did not vouch for. Links written before this were
-- unreviewed proposals; the next run of every company's links task replaces them. Additive only.
ALTER TABLE sec_business_links ADD COLUMN review TEXT;
