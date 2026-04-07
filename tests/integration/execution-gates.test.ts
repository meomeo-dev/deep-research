import { describe, expect, it } from "vitest";
import {
  evaluateExecutionGates,
  type EvaluateExecutionGatesInput
} from "../../src/application/gates/execution-gates";
import type {
  BranchRecord,
  EdgeView,
  EvidenceView,
  GraphEvidenceLinkView,
  GraphView,
  NodeView,
  ResearchRecord
} from "../../src/domain/contracts";

const baseResearch = (): ResearchRecord => ({
  createdAt: "2026-04-07T00:00:00.000Z",
  currentBranchId: "branch_main",
  id: "research_gate_test",
  lifecycleState: "review",
  maturityState: "substantiated",
  question: "Do execution gates behave correctly?",
  title: "Execution gate test",
  updatedAt: "2026-04-07T00:00:00.000Z"
});

const baseBranch = (): BranchRecord => ({
  branchState: "active",
  createdAt: "2026-04-07T00:00:00.000Z",
  forkedFromVersionId: null,
  headVersionId: "version_main",
  id: "branch_main",
  name: "main",
  parentBranchId: null,
  researchId: "research_gate_test"
});

const buildNode = (overrides: Partial<NodeView> & Pick<NodeView, "id" | "kind" | "title">): NodeView => ({
  body: "",
  epistemicState: "supported",
  workflowState: "ready",
  ...overrides
});

const buildEvidence = (
  overrides: Partial<EvidenceView> & Pick<EvidenceView, "id" | "title" | "sourceUri">
): EvidenceView => ({
  archiveStatus: "none",
  failureReason: null,
  publishedAt: null,
  summary: "summary",
  trustLevel: 3,
  verificationNotes: "verified",
  verifiedAt: "2026-04-07T00:00:00.000Z",
  ...overrides
});

const buildEdge = (overrides: Partial<EdgeView> & Pick<EdgeView, "id" | "fromNodeId" | "toNodeId">): EdgeView => ({
  kind: "supports",
  ...overrides
});

const buildEvidenceLink = (
  overrides: Partial<GraphEvidenceLinkView> & Pick<GraphEvidenceLinkView, "evidenceId" | "nodeId">
): GraphEvidenceLinkView => ({
  relation: "supports",
  ...overrides
});

const buildInput = (overrides?: Partial<EvaluateExecutionGatesInput>): EvaluateExecutionGatesInput => {
  const questionNode = buildNode({
    id: "node_question",
    kind: "question",
    title: "Question"
  });
  const hypothesisNode = buildNode({
    id: "node_hypothesis",
    kind: "hypothesis",
    title: "Hypothesis"
  });
  const evidence = buildEvidence({
    id: "evidence_1",
    sourceUri: "https://example.com/evidence",
    title: "Evidence"
  });
  const edge = buildEdge({
    id: "edge_1",
    fromNodeId: questionNode.id,
    toNodeId: hypothesisNode.id
  });
  const evidenceLink = buildEvidenceLink({
    evidenceId: evidence.id,
    nodeId: hypothesisNode.id
  });
  const graph: GraphView = {
    branch: baseBranch(),
    edges: [edge],
    evidenceByNode: {
      [hypothesisNode.id]: [
        {
          evidenceId: evidence.id,
          relation: "supports",
          title: evidence.title,
          trustLevel: evidence.trustLevel,
          verifiedAt: evidence.verifiedAt
        }
      ]
    },
    evidenceIndex: {
      [evidence.id]: evidence
    },
    evidenceLinks: [evidenceLink],
    nodes: [questionNode, hypothesisNode]
  };

  return {
    branch: baseBranch(),
    checkedAt: "2026-04-07T00:00:00.000Z",
    evidence: [evidence],
    graph,
    lifecycleRuns: ["synthesize", "review"],
    nodes: graph.nodes,
    research: baseResearch(),
    ...overrides
  };
};

describe("evaluateExecutionGates", () => {
  it("passes when minimum DAG, evidence chain, and lifecycle requirements are satisfied", () => {
    const report = evaluateExecutionGates(buildInput());

    expect(report.ok).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.checks.gate0.ok).toBe(true);
    expect(report.checks.gate1.ok).toBe(true);
    expect(report.checks.gate2.ok).toBe(true);
  });

  it("returns blocking issues when required DAG nodes, evidence verification, and lifecycle runs are missing", () => {
    const questionNode = buildNode({
      epistemicState: "untested",
      id: "node_question",
      kind: "question",
      title: "Question",
      workflowState: "draft"
    });
    const evidence = buildEvidence({
      id: "evidence_1",
      sourceUri: "https://example.com/evidence",
      title: "Evidence",
      verificationNotes: "",
      verifiedAt: null
    });
    const graph: GraphView = {
      branch: baseBranch(),
      edges: [],
      evidenceByNode: {},
      evidenceIndex: {
        [evidence.id]: evidence
      },
      evidenceLinks: [],
      nodes: [questionNode]
    };

    const report = evaluateExecutionGates(
      buildInput({
        evidence: [evidence],
        graph,
        lifecycleRuns: [],
        nodes: [questionNode]
      })
    );

    expect(report.ok).toBe(false);
    expect(report.issues.filter((issue) => issue.blocking).map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "GATE0_MISSING_HYPOTHESIS_OR_TASK",
        "GATE0_MISSING_GRAPH_LINK",
        "GATE1_UNVERIFIED_EVIDENCE",
        "GATE1_UNLINKED_EVIDENCE",
        "GATE2_MISSING_SYNTHESIZE_RUN",
        "GATE2_MISSING_REVIEW_RUN",
        "GATE2_DRAFT_CORE_NODES",
        "GATE2_UNTESTED_CORE_NODES"
      ])
    );
  });

  it("keeps the report exportable when only inconclusive core nodes remain", () => {
    const questionNode = buildNode({
      id: "node_question",
      kind: "question",
      title: "Question"
    });
    const taskNode = buildNode({
      epistemicState: "inconclusive",
      id: "node_task",
      kind: "task",
      title: "Task"
    });
    const edge = buildEdge({
      id: "edge_1",
      fromNodeId: questionNode.id,
      toNodeId: taskNode.id
    });
    const evidence = buildEvidence({
      id: "evidence_1",
      sourceUri: "https://example.com/evidence",
      title: "Evidence"
    });
    const graph: GraphView = {
      branch: baseBranch(),
      edges: [edge],
      evidenceByNode: {
        [taskNode.id]: [
          {
            evidenceId: evidence.id,
            relation: "supports",
            title: evidence.title,
            trustLevel: evidence.trustLevel,
            verifiedAt: evidence.verifiedAt
          }
        ]
      },
      evidenceIndex: {
        [evidence.id]: evidence
      },
      evidenceLinks: [
        buildEvidenceLink({
          evidenceId: evidence.id,
          nodeId: taskNode.id
        })
      ],
      nodes: [questionNode, taskNode]
    };

    const report = evaluateExecutionGates(
      buildInput({
        graph,
        nodes: [questionNode, taskNode]
      })
    );

    expect(report.ok).toBe(true);
    expect(report.checks.gate2.ok).toBe(true);
    expect(report.issues).toEqual([
      expect.objectContaining({
        blocking: false,
        code: "GATE2_INCONCLUSIVE_CORE_NODES",
        gate: "gate2"
      })
    ]);
  });
});