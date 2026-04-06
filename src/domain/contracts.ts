export const researchLifecycleStates = [
  "draft",
  "scoped",
  "active",
  "synthesizing",
  "review",
  "completed",
  "paused",
  "archived",
  "cancelled",
  "reopened"
] as const;

export const researchMaturityStates = [
  "exploratory",
  "converging",
  "substantiated",
  "unresolved"
] as const;

export const branchStates = [
  "active",
  "dormant",
  "diverged",
  "superseded",
  "archived"
] as const;

export const nodeKinds = [
  "question",
  "hypothesis",
  "evidence",
  "finding",
  "gap",
  "task",
  "conclusion",
  "note"
] as const;

export const nodeWorkflowStates = [
  "draft",
  "ready",
  "active",
  "blocked",
  "resolved",
  "removed"
] as const;

export const nodeEpistemicStates = [
  "untested",
  "supported",
  "contradicted",
  "inconclusive",
  "superseded"
] as const;

export const edgeKinds = [
  "supports",
  "refutes",
  "depends_on",
  "derived_from",
  "annotates"
] as const;

export const evidenceRelations = ["supports", "refutes", "annotates"] as const;

export type ResearchLifecycleState = (typeof researchLifecycleStates)[number];
export type ResearchMaturityState = (typeof researchMaturityStates)[number];
export type BranchState = (typeof branchStates)[number];
export type NodeKind = (typeof nodeKinds)[number];
export type NodeWorkflowState = (typeof nodeWorkflowStates)[number];
export type NodeEpistemicState = (typeof nodeEpistemicStates)[number];
export type EdgeKind = (typeof edgeKinds)[number];
export type EvidenceRelation = (typeof evidenceRelations)[number];

export interface ResearchRecord {
  id: string;
  title: string;
  question: string;
  lifecycleState: ResearchLifecycleState;
  maturityState: ResearchMaturityState;
  currentBranchId: string;
  createdAt: string;
  updatedAt: string;
}

export interface BranchRecord {
  id: string;
  researchId: string;
  name: string;
  parentBranchId: string | null;
  forkedFromVersionId: string | null;
  headVersionId: string;
  branchState: BranchState;
  createdAt: string;
}

export interface VersionRecord {
  id: string;
  researchId: string;
  branchId: string;
  parentVersionId: string | null;
  versionNumber: number;
  reason: string;
  createdAt: string;
}

export interface NodeView {
  id: string;
  kind: NodeKind;
  title: string;
  body: string;
  workflowState: NodeWorkflowState;
  epistemicState: NodeEpistemicState;
}

export interface EdgeView {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
}

export interface EvidenceView {
  id: string;
  sourceUri: string;
  title: string;
  summary: string;
  trustLevel: number;
  publishedAt: string | null;
  verifiedAt: string | null;
  verificationNotes: string;
}

export interface ArtifactView {
  id: string;
  artifactKind: string;
  title: string;
  body: string;
  branchId: string | null;
  versionId: string | null;
  nodeId: string | null;
  createdAt: string;
}

export interface GraphEvidenceLinkView {
  evidenceId: string;
  nodeId: string;
  relation: EvidenceRelation;
}

export interface GraphEvidenceSummaryView {
  evidenceId: string;
  relation: EvidenceRelation;
  title: string;
  trustLevel: number;
  verifiedAt: string | null;
}

export interface GraphView {
  branch: BranchRecord;
  edges: EdgeView[];
  evidenceByNode: Record<string, GraphEvidenceSummaryView[]>;
  evidenceIndex: Record<string, EvidenceView>;
  evidenceLinks: GraphEvidenceLinkView[];
  nodes: NodeView[];
}