ALTER TABLE evidence_items ADD COLUMN archive_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE evidence_items ADD COLUMN failure_reason TEXT;

ALTER TABLE artifacts ADD COLUMN evidence_id TEXT REFERENCES evidence_items(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_evidence_research_archive_status
  ON evidence_items(research_id, archive_status);

CREATE INDEX IF NOT EXISTS idx_artifacts_evidence
  ON artifacts(evidence_id);

CREATE INDEX IF NOT EXISTS idx_artifacts_research_kind
  ON artifacts(research_id, artifact_kind);