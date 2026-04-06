CREATE TABLE IF NOT EXISTS researches (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  scope_json TEXT NOT NULL DEFAULT '{}',
  lifecycle_state TEXT NOT NULL,
  maturity_state TEXT NOT NULL,
  current_branch_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  parent_branch_id TEXT REFERENCES branches(id),
  forked_from_version_id TEXT REFERENCES versions(id),
  head_version_id TEXT,
  branch_state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE(research_id, name)
);

CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  branch_id TEXT NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  parent_version_id TEXT REFERENCES versions(id),
  version_number INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(branch_id, version_number)
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  stable_key TEXT NOT NULL,
  node_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(research_id, stable_key)
);

CREATE TABLE IF NOT EXISTS node_snapshots (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  workflow_state TEXT NOT NULL,
  epistemic_state TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edge_snapshots (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  edge_id TEXT NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  from_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  to_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  edge_kind TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_items (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  source_uri TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  trust_level INTEGER NOT NULL,
  published_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_evidence_links (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence_items(id) ON DELETE CASCADE,
  relation_kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(node_id, evidence_id, relation_kind)
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  branch_id TEXT REFERENCES branches(id),
  version_id TEXT REFERENCES versions(id),
  node_id TEXT REFERENCES nodes(id),
  artifact_kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  research_id TEXT NOT NULL REFERENCES researches(id) ON DELETE CASCADE,
  branch_id TEXT REFERENCES branches(id),
  version_id TEXT REFERENCES versions(id),
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_branches_research ON branches(research_id);
CREATE INDEX IF NOT EXISTS idx_versions_branch ON versions(branch_id, version_number);
CREATE INDEX IF NOT EXISTS idx_node_snapshots_version ON node_snapshots(version_id);
CREATE INDEX IF NOT EXISTS idx_edge_snapshots_version ON edge_snapshots(version_id);
CREATE INDEX IF NOT EXISTS idx_evidence_research ON evidence_items(research_id);
CREATE INDEX IF NOT EXISTS idx_events_research ON events(research_id, occurred_at);