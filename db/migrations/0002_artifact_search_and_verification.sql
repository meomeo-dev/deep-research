ALTER TABLE evidence_items ADD COLUMN verified_at TEXT;
ALTER TABLE evidence_items ADD COLUMN verification_notes TEXT NOT NULL DEFAULT '';

CREATE VIRTUAL TABLE IF NOT EXISTS artifact_fts USING fts5(
  artifact_id UNINDEXED,
  research_id UNINDEXED,
  title,
  body
);