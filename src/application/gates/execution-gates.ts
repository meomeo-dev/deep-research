import {
  type BranchRecord,
  type EvidenceView,
  type GraphView,
  type NodeView,
  type ResearchRecord
} from "../../domain/contracts";
import { assertAcyclic } from "../../domain/graph";
import { AppError } from "../../shared/errors";

export interface ExecutionGateIssue {
  gate: "gate0" | "gate1" | "gate2";
  code: string;
  message: string;
  blocking: boolean;
  details?: Record<string, unknown>;
}

export interface ExecutionGateReport {
  ok: boolean;
  checkedAt: string;
  research: ResearchRecord;
  branch: BranchRecord;
  checks: {
    gate0: {
      ok: boolean;
      minimumDag: {
        questionNodes: number;
        hypothesisOrTaskNodes: number;
        graphLinks: number;
      };
    };
    gate1: {
      ok: boolean;
      evidenceCount: number;
      verifiedEvidenceCount: number;
      linkedEvidenceCount: number;
      unverifiedEvidenceIds: string[];
      unlinkedEvidenceIds: string[];
    };
    gate2: {
      ok: boolean;
      inspections: {
        nodeListExecuted: true;
        evidenceListExecuted: true;
      };
      lifecycleRuns: {
        synthesize: boolean;
        review: boolean;
      };
      graphAcyclic: boolean;
      draftCoreNodeIds: string[];
      untestedCoreNodeIds: string[];
      inconclusiveCoreNodeIds: string[];
    };
  };
  issues: ExecutionGateIssue[];
}

export interface EvaluateExecutionGatesInput {
  checkedAt: string;
  research: ResearchRecord;
  branch: BranchRecord;
  nodes: NodeView[];
  evidence: EvidenceView[];
  graph: GraphView;
  lifecycleRuns: Iterable<string>;
}

export const evaluateExecutionGates = (
  input: EvaluateExecutionGatesInput
): ExecutionGateReport => {
  const issues: ExecutionGateIssue[] = [];
  const questionNodes = input.nodes.filter((node) => node.kind === "question");
  const hypothesisOrTaskNodes = input.nodes.filter(
    (node) => node.kind === "hypothesis" || node.kind === "task"
  );
  const gate0Ok =
    questionNodes.length > 0 &&
    hypothesisOrTaskNodes.length > 0 &&
    input.graph.edges.length > 0;

  if (questionNodes.length === 0) {
    issues.push({
      blocking: true,
      code: "GATE0_MISSING_QUESTION",
      gate: "gate0",
      message: "Gate 0 requires at least one question node before search or reporting."
    });
  }
  if (hypothesisOrTaskNodes.length === 0) {
    issues.push({
      blocking: true,
      code: "GATE0_MISSING_HYPOTHESIS_OR_TASK",
      gate: "gate0",
      message: "Gate 0 requires at least one hypothesis or task node in the DAG.",
      details: { acceptedKinds: ["hypothesis", "task"] }
    });
  }
  if (input.graph.edges.length === 0) {
    issues.push({
      blocking: true,
      code: "GATE0_MISSING_GRAPH_LINK",
      gate: "gate0",
      message: "Gate 0 requires at least one graph_link edge describing the research path."
    });
  }

  const linkedEvidenceIds = new Set(input.graph.evidenceLinks.map((link) => link.evidenceId));
  const unverifiedEvidenceIds = input.evidence
    .filter((item) => item.verifiedAt === null)
    .map((item) => item.id);
  const unlinkedEvidenceIds = input.evidence
    .filter((item) => !linkedEvidenceIds.has(item.id))
    .map((item) => item.id);
  const gate1Ok =
    input.evidence.length > 0 &&
    unverifiedEvidenceIds.length === 0 &&
    unlinkedEvidenceIds.length === 0;

  if (input.evidence.length === 0) {
    issues.push({
      blocking: true,
      code: "GATE1_MISSING_EVIDENCE",
      gate: "gate1",
      message: "Gate 1 requires at least one persisted evidence record before final reporting."
    });
  }
  if (unverifiedEvidenceIds.length > 0) {
    issues.push({
      blocking: true,
      code: "GATE1_UNVERIFIED_EVIDENCE",
      gate: "gate1",
      message: "Gate 1 requires every persisted evidence item to pass evidence_verify before reporting.",
      details: { evidenceIds: unverifiedEvidenceIds }
    });
  }
  if (unlinkedEvidenceIds.length > 0) {
    issues.push({
      blocking: true,
      code: "GATE1_UNLINKED_EVIDENCE",
      gate: "gate1",
      message: "Gate 1 requires every persisted evidence item to be connected through evidence_link before reporting.",
      details: { evidenceIds: unlinkedEvidenceIds }
    });
  }

  const lifecycleRuns = new Set(input.lifecycleRuns);
  const coreNodes = input.nodes.filter(
    (node) => node.kind !== "note" && node.kind !== "evidence"
  );
  const draftCoreNodes = coreNodes
    .filter((node) => node.workflowState === "draft")
    .map((node) => node.id);
  const untestedCoreNodes = coreNodes
    .filter((node) => node.epistemicState === "untested")
    .map((node) => node.id);
  const inconclusiveCoreNodes = coreNodes
    .filter((node) => node.epistemicState === "inconclusive")
    .map((node) => node.id);

  let graphAcyclic = true;
  try {
    assertAcyclic(input.graph.edges);
  } catch (error) {
    graphAcyclic = false;
    if (error instanceof AppError) {
      issues.push({
        blocking: true,
        code: "GATE2_GRAPH_INVALID",
        gate: "gate2",
        message: error.message,
        details: error.details
      });
    } else {
      throw error;
    }
  }

  if (!lifecycleRuns.has("synthesize")) {
    issues.push({
      blocking: true,
      code: "GATE2_MISSING_SYNTHESIZE_RUN",
      gate: "gate2",
      message: "Gate 2 requires run --mode synthesize before final reporting."
    });
  }
  if (!lifecycleRuns.has("review")) {
    issues.push({
      blocking: true,
      code: "GATE2_MISSING_REVIEW_RUN",
      gate: "gate2",
      message: "Gate 2 requires run --mode review before final reporting."
    });
  }
  if (draftCoreNodes.length > 0) {
    issues.push({
      blocking: true,
      code: "GATE2_DRAFT_CORE_NODES",
      gate: "gate2",
      message: "Gate 2 forbids core nodes from remaining in workflow state draft.",
      details: { nodeIds: draftCoreNodes }
    });
  }
  if (untestedCoreNodes.length > 0) {
    issues.push({
      blocking: true,
      code: "GATE2_UNTESTED_CORE_NODES",
      gate: "gate2",
      message: "Gate 2 forbids core nodes from remaining in epistemic state untested.",
      details: { nodeIds: untestedCoreNodes }
    });
  }
  if (inconclusiveCoreNodes.length > 0) {
    issues.push({
      blocking: false,
      code: "GATE2_INCONCLUSIVE_CORE_NODES",
      gate: "gate2",
      message: "Core nodes in epistemic state inconclusive are allowed only if the final report explains why they remain unresolved.",
      details: { nodeIds: inconclusiveCoreNodes }
    });
  }

  const gate2Ok =
    graphAcyclic &&
    lifecycleRuns.has("synthesize") &&
    lifecycleRuns.has("review") &&
    draftCoreNodes.length === 0 &&
    untestedCoreNodes.length === 0;

  return {
    branch: input.branch,
    checkedAt: input.checkedAt,
    checks: {
      gate0: {
        minimumDag: {
          graphLinks: input.graph.edges.length,
          hypothesisOrTaskNodes: hypothesisOrTaskNodes.length,
          questionNodes: questionNodes.length
        },
        ok: gate0Ok
      },
      gate1: {
        evidenceCount: input.evidence.length,
        linkedEvidenceCount: linkedEvidenceIds.size,
        ok: gate1Ok,
        unlinkedEvidenceIds,
        unverifiedEvidenceIds,
        verifiedEvidenceCount: input.evidence.length - unverifiedEvidenceIds.length
      },
      gate2: {
        draftCoreNodeIds: draftCoreNodes,
        graphAcyclic,
        inconclusiveCoreNodeIds: inconclusiveCoreNodes,
        inspections: {
          evidenceListExecuted: true,
          nodeListExecuted: true
        },
        lifecycleRuns: {
          review: lifecycleRuns.has("review"),
          synthesize: lifecycleRuns.has("synthesize")
        },
        ok: gate2Ok,
        untestedCoreNodeIds: untestedCoreNodes
      }
    },
    issues,
    ok: issues.every((issue) => !issue.blocking),
    research: input.research
  };
};