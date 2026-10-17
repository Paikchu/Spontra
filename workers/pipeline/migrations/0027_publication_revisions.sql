-- The revision of each resource the business map reads, per company: the time of the latest event that published into
-- it. The map compares revisions to tell a reader newer data is out and keys its cache on them. A global publication
-- (peers) is kept under ticker '*'. Additive only.
CREATE TABLE publication_revisions (
 ticker TEXT NOT NULL,
 resource TEXT NOT NULL,
 revision TEXT NOT NULL,
 PRIMARY KEY (ticker, resource)
);
