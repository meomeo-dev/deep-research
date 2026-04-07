import type Database from "better-sqlite3";
import {
  type ExecutionGateReport,
  evaluateExecutionGates
} from "../gates/execution-gates";
import {
  type EvidenceArchiveBackend,
  type EvidenceArchiveView,
  type ArtifactView,
  edgeKinds,
  evidenceArchiveStatuses,
  evidenceRelations,
  type GraphEvidenceLinkView,
  type GraphEvidenceSummaryView,
  type GraphView,
  nodeKinds,
  type BranchRecord,
  type BranchState,
  type EdgeKind,
  type EdgeView,
  type EvidenceRelation,
  type EvidenceView,
  type NodeEpistemicState,
  type NodeKind,
  type NodeView,
  type NodeWorkflowState,
  type ResearchRecord,
  type VersionRecord
} from "../../domain/contracts";
import { assertAcyclic } from "../../domain/graph";
import { AppError } from "../../shared/errors";
import { createId } from "../../shared/ids";
import { archiveEvidenceWithBackend } from "./evidence-archive-backends";

const now = (): string => new Date().toISOString();

type Row = Record<string, unknown>;

export interface InitResearchInput {
  title: string;
  question: string;
}

export interface BranchDiff {
  onlyInLeft: NodeView[];
  onlyInRight: NodeView[];
  changed: Array<{ left: NodeView; right: NodeView }>;
}

export interface EvidenceDetail extends EvidenceView {
  links: Array<{ nodeId: string; relation: EvidenceRelation }>;
}

interface EventInsertInput {
  aggregateId: string;
  aggregateType: string;
  branchId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  researchId: string;
  versionId: string | null;
}

export class ResearchService {
  constructor(private readonly db: Database.Database) {}

  initResearch(input: InitResearchInput): ResearchRecord {
    const timestamp = now();
    const researchId = createId("research");
    const branchId = createId("branch");
    const versionId = createId("version");

    this.db.transaction(() => {
      this.db.prepare(
        `
          INSERT INTO researches (
            id, title, question, lifecycle_state, maturity_state,
            current_branch_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'draft', 'exploratory', ?, ?, ?)
        `
      ).run(researchId, input.title, input.question, branchId, timestamp, timestamp);

      this.db.prepare(
        `
          INSERT INTO branches (
            id, research_id, name, head_version_id, branch_state, created_at
          ) VALUES (?, ?, 'main', ?, 'active', ?)
        `
      ).run(branchId, researchId, versionId, timestamp);

      this.db.prepare(
        `
          INSERT INTO versions (
            id, research_id, branch_id, version_number, reason, created_at
          ) VALUES (?, ?, ?, 1, 'Initialize research', ?)
        `
      ).run(versionId, researchId, branchId, timestamp);

      this.recordEvent(
        researchId,
        branchId,
        versionId,
        "research",
        researchId,
        "research_initialized",
        { title: input.title }
      );
    })();

    return this.requireResearch(researchId);
  }

  listResearchs(query?: string): ResearchRecord[] {
    if (!query) {
      return this.db
        .prepare(
          `
            SELECT id, title, question, lifecycle_state, maturity_state,
                   current_branch_id, created_at, updated_at
            FROM researches
            ORDER BY updated_at DESC
          `
        )
        .all()
        .map((row) => this.mapResearch(row as Row));
    }

    return this.db
      .prepare(
        `
          SELECT DISTINCT r.id, r.title, r.question, r.lifecycle_state,
                 r.maturity_state, r.current_branch_id, r.created_at, r.updated_at
          FROM researches r
          LEFT JOIN branches b ON b.research_id = r.id
          LEFT JOIN node_snapshots ns ON ns.version_id = b.head_version_id
          LEFT JOIN evidence_items ei ON ei.research_id = r.id
          LEFT JOIN artifact_fts af ON af.research_id = r.id
          WHERE lower(r.title) LIKE lower(?)
             OR lower(r.question) LIKE lower(?)
             OR lower(ns.title) LIKE lower(?)
             OR lower(ns.body) LIKE lower(?)
             OR lower(ei.title) LIKE lower(?)
             OR lower(ei.summary) LIKE lower(?)
             OR lower(ei.source_uri) LIKE lower(?)
             OR lower(ei.verification_notes) LIKE lower(?)
             OR lower(af.title) LIKE lower(?)
             OR lower(af.body) LIKE lower(?)
          ORDER BY r.updated_at DESC
        `
      )
      .all(
        `%${query}%`,
        `%${query}%`,
        `%${query}%`,
        `%${query}%`,
        `%${query}%`,
        `%${query}%`,
        `%${query}%`,
        `%${query}%`,
        `%${query}%`,
        `%${query}%`
      )
      .map((row) => this.mapResearch(row as Row));
  }

  advanceResearch(
    mode: "plan" | "evidence" | "synthesize" | "review" | "complete",
    researchId?: string
  ): ResearchRecord {
    const research = this.resolveResearch(researchId);
    const lifecycleState =
      mode === "synthesize"
        ? "synthesizing"
        : mode === "review"
          ? "review"
          : mode === "complete"
            ? "completed"
            : "active";
    const maturityState =
      mode === "plan"
        ? "exploratory"
        : mode === "evidence"
          ? "converging"
          : "substantiated";

    this.db.transaction(() => {
      this.db.prepare(
        `
          UPDATE researches
          SET lifecycle_state = ?, maturity_state = ?, updated_at = ?
          WHERE id = ?
        `
      ).run(lifecycleState, maturityState, now(), research.id);
      this.recordEvent(research.id, research.currentBranchId, null, "research", research.id, "research_advanced", { mode });
    })();
    return this.requireResearch(research.id);
  }

  getStatus(researchId?: string, branchName?: string): Record<string, unknown> {
    const research = this.resolveResearch(researchId);
    const branch = branchName
      ? this.requireBranchByName(research.id, branchName)
      : this.requireCurrentBranch(research.id);
    const version = this.requireVersion(branch.headVersionId);
    const nodes = this.listNodes(research.id, branch.name);
    const evidenceCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM evidence_items WHERE research_id = ?")
      .get(research.id) as { count: number };
    const artifactCount = this.db
      .prepare("SELECT COUNT(*) AS count FROM artifacts WHERE research_id = ?")
      .get(research.id) as { count: number };
    const verifiedEvidenceCount = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM evidence_items WHERE research_id = ? AND verified_at IS NOT NULL"
      )
      .get(research.id) as { count: number };

    return {
      research,
      branch,
      version,
      counts: {
        artifacts: artifactCount.count,
        nodes: nodes.length,
        blockedNodes: nodes.filter((node) => node.workflowState === "blocked").length,
        inconclusiveNodes: nodes.filter((node) => node.epistemicState === "inconclusive").length,
        evidence: evidenceCount.count,
        resolvedNodes: nodes.filter((node) => node.workflowState === "resolved").length,
        verifiedEvidence: verifiedEvidenceCount.count
      }
    };
  }

  listBranches(researchId?: string): BranchRecord[] {
    const resolved = this.resolveResearch(researchId);
    return this.db
      .prepare(
        `
          SELECT id, research_id, name, parent_branch_id, forked_from_version_id,
                 head_version_id, branch_state, created_at
          FROM branches
          WHERE research_id = ?
          ORDER BY created_at ASC
        `
      )
      .all(resolved.id)
      .map((row) => this.mapBranch(row as Row));
  }

  createBranch(name: string, reason: string, researchId?: string, from?: string): BranchRecord {
    const research = this.resolveResearch(researchId);
    const sourceBranch = from
      ? this.findBranchOrVersionSource(research.id, from)
      : this.requireCurrentBranch(research.id);
    const branchId = createId("branch");
    const timestamp = now();

    this.db.transaction(() => {
      this.db.prepare(
        `
          INSERT INTO branches (
            id, research_id, name, parent_branch_id, forked_from_version_id,
            head_version_id, branch_state, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
        `
      ).run(
        branchId,
        research.id,
        name,
        sourceBranch.id,
        sourceBranch.headVersionId,
        sourceBranch.headVersionId,
        timestamp
      );

      this.recordEvent(
        research.id,
        branchId,
        sourceBranch.headVersionId,
        "branch",
        branchId,
        "branch_created",
        { reason, from }
      );
    })();

    return this.requireBranchByName(research.id, name);
  }

  switchBranch(name: string, researchId?: string): BranchRecord {
    const research = this.resolveResearch(researchId);
    const branch = this.requireBranchByName(research.id, name);
    this.db.prepare(
      "UPDATE researches SET current_branch_id = ?, updated_at = ? WHERE id = ?"
    ).run(branch.id, now(), research.id);
    return branch;
  }

  archiveBranch(name: string, researchId?: string): BranchRecord {
    const research = this.resolveResearch(researchId);
    const branch = this.requireBranchByName(research.id, name);
    const timestamp = now();
    this.db.transaction(() => {
      this.db.prepare(
        "UPDATE branches SET branch_state = 'archived', archived_at = ? WHERE id = ?"
      ).run(timestamp, branch.id);
      this.recordEvent(research.id, branch.id, branch.headVersionId, "branch", branch.id, "branch_archived", {});
    })();
    return this.requireBranchByName(research.id, name);
  }

  listNodes(researchId?: string, branchName?: string): NodeView[] {
    const research = this.resolveResearch(researchId);
    const branch = branchName
      ? this.requireBranchByName(research.id, branchName)
      : this.requireCurrentBranch(research.id);

    return this.db
      .prepare(
        `
          SELECT ns.node_id AS id, n.node_kind AS kind, ns.title, ns.body,
                 ns.workflow_state, ns.epistemic_state
          FROM node_snapshots ns
          JOIN nodes n ON n.id = ns.node_id
          WHERE ns.version_id = ?
            AND ns.is_deleted = 0
          ORDER BY ns.created_at ASC
        `
      )
      .all(branch.headVersionId)
      .map((row) => this.mapNode(row as Row));
  }

  listVersions(researchId?: string, branchName?: string): VersionRecord[] {
    const research = this.resolveResearch(researchId);
    const branch = branchName
      ? this.requireBranchByName(research.id, branchName)
      : this.requireCurrentBranch(research.id);

    return this.db
      .prepare(
        `
          SELECT id, research_id, branch_id, parent_version_id, version_number,
                 reason, created_at
          FROM versions
          WHERE branch_id = ?
          ORDER BY version_number DESC
        `
      )
      .all(branch.id)
      .map((row) => this.mapVersion(row as Row));
  }

  addNode(input: {
    researchId?: string;
    branchName?: string;
    kind: NodeKind;
    title: string;
    body?: string;
    workflowState?: NodeWorkflowState;
    epistemicState?: NodeEpistemicState;
  }): NodeView {
    if (!nodeKinds.includes(input.kind)) {
      throw new AppError("INVALID_NODE_KIND", `Unsupported node kind: ${input.kind}`, 2);
    }

    const research = this.resolveResearch(input.researchId);
    const branch = input.branchName
      ? this.requireBranchByName(research.id, input.branchName)
      : this.requireCurrentBranch(research.id);
    const nodeId = createId("node");
    const snapshotId = createId("node_snapshot");
    const { version } = this.mutateBranchVersion({
      branch,
      event: {
        aggregateId: nodeId,
        aggregateType: "node",
        branchId: branch.id,
        eventType: "node_added",
        payload: {
          kind: input.kind,
          title: input.title
        },
        researchId: research.id,
        versionId: null
      },
      mutate: (version, timestamp) => {
        this.db.prepare(
          `
            INSERT INTO nodes (id, research_id, stable_key, node_kind, created_at)
            VALUES (?, ?, ?, ?, ?)
          `
        ).run(nodeId, research.id, nodeId, input.kind, timestamp);

        this.db.prepare(
          `
            INSERT INTO node_snapshots (
              id, version_id, node_id, title, body, workflow_state,
              epistemic_state, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          snapshotId,
          version.id,
          nodeId,
          input.title,
          input.body ?? "",
          input.workflowState ?? "draft",
          input.epistemicState ?? "untested",
          timestamp
        );
      },
      reason: "Add node"
    });
    return this.requireNode(version.id, nodeId);
  }

  updateNode(input: {
    researchId?: string;
    branchName?: string;
    nodeId: string;
    title?: string;
    body?: string;
    workflowState?: NodeWorkflowState;
    epistemicState?: NodeEpistemicState;
  }): NodeView {
    const research = this.resolveResearch(input.researchId);
    const branch = input.branchName
      ? this.requireBranchByName(research.id, input.branchName)
      : this.requireCurrentBranch(research.id);
    const current = this.requireNode(branch.headVersionId, input.nodeId);
    const { version } = this.mutateBranchVersion({
      branch,
      event: {
        aggregateId: input.nodeId,
        aggregateType: "node",
        branchId: branch.id,
        eventType: "node_updated",
        payload: input,
        researchId: research.id,
        versionId: null
      },
      mutate: (version, timestamp) => {
        const outcome = this.db.prepare(
          `
            UPDATE node_snapshots
            SET title = ?, body = ?, workflow_state = ?, epistemic_state = ?, created_at = ?
            WHERE version_id = ? AND node_id = ?
          `
        ).run(
          input.title ?? current.title,
          input.body ?? current.body,
          input.workflowState ?? current.workflowState,
          input.epistemicState ?? current.epistemicState,
          timestamp,
          version.id,
          input.nodeId
        );
        if (outcome.changes !== 1) {
          throw new AppError("NODE_NOT_FOUND", `Node ${input.nodeId} was not found.`, 2, {
            committed: false,
            branchName: branch.name,
            nodeId: input.nodeId
          });
        }
      },
      reason: "Update node"
    });
    return this.requireNode(version.id, input.nodeId);
  }

  moveNode(input: {
    researchId?: string;
    branchName?: string;
    nodeId: string;
    beforeNodeId?: string;
    afterNodeId?: string;
  }): NodeView {
    const research = this.resolveResearch(input.researchId);
    const branch = input.branchName
      ? this.requireBranchByName(research.id, input.branchName)
      : this.requireCurrentBranch(research.id);
    const payload = JSON.stringify({
      afterNodeId: input.afterNodeId ?? null,
      beforeNodeId: input.beforeNodeId ?? null
    });

    const { version } = this.mutateBranchVersion({
      branch,
      event: {
        aggregateId: input.nodeId,
        aggregateType: "node",
        branchId: branch.id,
        eventType: "node_moved",
        payload: { payload },
        researchId: research.id,
        versionId: null
      },
      mutate: (version, timestamp) => {
        const outcome = this.db.prepare(
          `
            UPDATE node_snapshots
            SET payload_json = ?, created_at = ?
            WHERE version_id = ? AND node_id = ?
          `
        ).run(payload, timestamp, version.id, input.nodeId);
        if (outcome.changes !== 1) {
          throw new AppError("NODE_NOT_FOUND", `Node ${input.nodeId} was not found.`, 2, {
            committed: false,
            branchName: branch.name,
            nodeId: input.nodeId
          });
        }
      },
      reason: "Move node"
    });
    return this.requireNode(version.id, input.nodeId);
  }

  resolveNode(nodeId: string, researchId?: string, branchName?: string): NodeView {
    return this.updateNode({
      branchName,
      epistemicState: "supported",
      nodeId,
      researchId,
      workflowState: "resolved"
    });
  }

  removeNode(nodeId: string, researchId?: string, branchName?: string): NodeView {
    const research = this.resolveResearch(researchId);
    const branch = branchName
      ? this.requireBranchByName(research.id, branchName)
      : this.requireCurrentBranch(research.id);
    const { version } = this.mutateBranchVersion({
      branch,
      event: {
        aggregateId: nodeId,
        aggregateType: "node",
        branchId: branch.id,
        eventType: "node_removed",
        payload: {},
        researchId: research.id,
        versionId: null
      },
      mutate: (version, timestamp) => {
        const outcome = this.db.prepare(
          `
            UPDATE node_snapshots
            SET workflow_state = 'removed', is_deleted = 1, created_at = ?
            WHERE version_id = ? AND node_id = ?
          `
        ).run(timestamp, version.id, nodeId);
        if (outcome.changes !== 1) {
          throw new AppError("NODE_NOT_FOUND", `Node ${nodeId} was not found.`, 2, {
            committed: false,
            branchName: branch.name,
            nodeId
          });
        }
      },
      reason: "Remove node"
    });
    return this.requireNode(version.id, nodeId, true);
  }

  addEdge(input: {
    researchId?: string;
    branchName?: string;
    fromNodeId: string;
    toNodeId: string;
    kind: EdgeKind;
  }): EdgeView {
    if (!edgeKinds.includes(input.kind)) {
      throw new AppError("INVALID_EDGE_KIND", `Unsupported edge kind: ${input.kind}`, 2);
    }
    const research = this.resolveResearch(input.researchId);
    const branch = input.branchName
      ? this.requireBranchByName(research.id, input.branchName)
      : this.requireCurrentBranch(research.id);
    this.requireNode(branch.headVersionId, input.fromNodeId);
    this.requireNode(branch.headVersionId, input.toNodeId);
    const edgeId = createId("edge");
    const snapshotId = createId("edge_snapshot");

    this.mutateBranchVersion({
      branch,
      event: {
        aggregateId: edgeId,
        aggregateType: "edge",
        branchId: branch.id,
        eventType: "edge_added",
        payload: input,
        researchId: research.id,
        versionId: null
      },
      mutate: (version, timestamp) => {
        this.db.prepare(
          "INSERT INTO edges (id, research_id, created_at) VALUES (?, ?, ?)"
        ).run(edgeId, research.id, timestamp);
        this.db.prepare(
          `
            INSERT INTO edge_snapshots (
              id, version_id, edge_id, from_node_id, to_node_id, edge_kind, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `
        ).run(
          snapshotId,
          version.id,
          edgeId,
          input.fromNodeId,
          input.toNodeId,
          input.kind,
          timestamp
        );

        try {
          assertAcyclic(this.listEdgesForVersion(version.id));
        } catch (error) {
          if (error instanceof AppError && error.code === "DAG_CYCLE") {
            throw new AppError(
              error.code,
              `Rejected before commit: adding ${input.fromNodeId} -> ${input.toNodeId} would create a cycle on branch ${branch.name}.`,
              error.exitCode,
              {
                branchName: branch.name,
                committed: false,
                cycleNodeId: error.details?.cycleNodeId,
                fromNodeId: input.fromNodeId,
                toNodeId: input.toNodeId
              }
            );
          }
          throw error;
        }
      },
      reason: "Add edge"
    });
    return { id: edgeId, fromNodeId: input.fromNodeId, toNodeId: input.toNodeId, kind: input.kind };
  }

  listEvidence(researchId?: string): EvidenceView[] {
    const research = this.resolveResearch(researchId);
    return this.db
      .prepare(
        `
          SELECT id, source_uri, title, summary, trust_level, published_at,
                 verified_at, verification_notes, archive_status, failure_reason
          FROM evidence_items
          WHERE research_id = ?
          ORDER BY created_at DESC
        `
      )
      .all(research.id)
      .map((row) => this.mapEvidence(row as Row));
  }

  showEvidence(evidenceId: string): EvidenceDetail {
    const evidence = this.requireEvidence(evidenceId);
    const links = this.db
      .prepare(
        `
          SELECT node_id, relation_kind
          FROM node_evidence_links
          WHERE evidence_id = ?
          ORDER BY created_at ASC
        `
      )
      .all(evidenceId)
      .map((row) => ({
        nodeId: String((row as Row).node_id),
        relation: String((row as Row).relation_kind) as EvidenceRelation
      }));

    return { ...evidence, links };
  }

  addEvidence(input: {
    researchId?: string;
    sourceUri: string;
    title: string;
    summary?: string;
    trustLevel?: number;
    publishedAt?: string;
  }): EvidenceView {
    const research = this.resolveResearch(input.researchId);
    const evidenceId = createId("evidence");
    this.db.transaction(() => {
      this.db.prepare(
        `
          INSERT INTO evidence_items (
            id, research_id, source_uri, title, summary, trust_level, published_at,
            verified_at, verification_notes, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '', ?)
        `
      ).run(
        evidenceId,
        research.id,
        input.sourceUri,
        input.title,
        input.summary ?? "",
        input.trustLevel ?? 3,
        input.publishedAt ?? null,
        now()
      );
      this.recordEvent(research.id, null, null, "evidence", evidenceId, "evidence_added", input);
    })();
    return this.requireEvidence(evidenceId);
  }

  async archiveEvidence(input: {
    researchId?: string;
    sourceUri: string;
    title?: string;
    summary?: string;
    trustLevel?: number;
    publishedAt?: string;
    backend?: EvidenceArchiveBackend;
    backendEndpoint?: string;
    sidecarManifestPath?: string;
    timeoutMs?: number;
  }): Promise<EvidenceArchiveView> {
    const research = this.resolveResearch(input.researchId);
    const archiveResult = await archiveEvidenceWithBackend({
      backend: input.backend ?? "crawl4ai",
      backendEndpoint: input.backendEndpoint,
      sidecarManifestPath: input.sidecarManifestPath,
      sourceUri: input.sourceUri,
      timeoutMs: input.timeoutMs ?? 15000
    });
    const evidenceId = createId("evidence");
    const artifactId = archiveResult.status === "archived" ? createId("artifact") : null;
    const evidenceTitle = input.title?.trim() || archiveResult.title;
    const evidenceSummary = input.summary?.trim() || archiveResult.summary;
    const timestamp = now();

    this.db.transaction(() => {
      this.db.prepare(
        `
          INSERT INTO evidence_items (
            id, research_id, source_uri, title, summary, trust_level, published_at,
            verified_at, verification_notes, archive_status, failure_reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '', ?, ?, ?)
        `
      ).run(
        evidenceId,
        research.id,
        archiveResult.sourceUri,
        evidenceTitle,
        evidenceSummary,
        input.trustLevel ?? 3,
        input.publishedAt ?? null,
        archiveResult.status,
        archiveResult.failureReason,
        timestamp
      );

      if (artifactId && archiveResult.body) {
        this.db.prepare(
          `
            INSERT INTO artifacts (
              id, research_id, branch_id, version_id, node_id,
              evidence_id, artifact_kind, title, body, created_at
            ) VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?)
          `
        ).run(
          artifactId,
          research.id,
          evidenceId,
          "web_archive",
          evidenceTitle,
          archiveResult.body,
          timestamp
        );

        this.db.prepare(
          `
            INSERT INTO artifact_fts (artifact_id, research_id, title, body)
            VALUES (?, ?, ?, ?)
          `
        ).run(artifactId, research.id, evidenceTitle, archiveResult.body);
      }

      this.recordEvent(
        research.id,
        null,
        null,
        "evidence",
        evidenceId,
        archiveResult.status === "archived" ? "evidence_archived" : "evidence_archive_degraded",
        {
          artifactId,
          backend: archiveResult.backend,
          failureReason: archiveResult.failureReason,
          sourceUri: archiveResult.sourceUri,
          status: archiveResult.status
        }
      );
    })();

    return {
      archive: {
        artifactId,
        artifactKind: artifactId ? "web_archive" : null,
        backend: archiveResult.backend,
        failureReason: archiveResult.failureReason,
        status: archiveResult.status
      },
      evidence: this.requireEvidence(evidenceId)
    };
  }

  verifyEvidence(
    evidenceId: string,
    notes: string,
    researchId?: string,
    trustLevel?: number
  ): EvidenceView {
    const research = this.resolveResearch(researchId);
    const current = this.requireEvidence(evidenceId);
    this.db.transaction(() => {
      this.db.prepare(
        `
          UPDATE evidence_items
          SET verified_at = ?, verification_notes = ?, trust_level = ?
          WHERE id = ? AND research_id = ?
        `
      ).run(now(), notes, trustLevel ?? current.trustLevel, evidenceId, research.id);
      this.recordEvent(research.id, null, null, "evidence", evidenceId, "evidence_verified", { notes, trustLevel });
    })();
    return this.requireEvidence(evidenceId);
  }

  linkEvidence(input: {
    researchId?: string;
    nodeId: string;
    evidenceId: string;
    relation: EvidenceRelation;
  }): Row {
    if (!evidenceRelations.includes(input.relation)) {
      throw new AppError("INVALID_EVIDENCE_RELATION", `Unsupported relation: ${input.relation}`, 2);
    }
    const research = this.resolveResearch(input.researchId);
    this.db.transaction(() => {
      this.db.prepare(
        `
          INSERT INTO node_evidence_links (
            id, research_id, node_id, evidence_id, relation_kind, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `
      ).run(createId("evidence_link"), research.id, input.nodeId, input.evidenceId, input.relation, now());
      this.recordEvent(research.id, null, null, "evidence_link", input.nodeId, "evidence_linked", input);
    })();
    return {
      evidenceId: input.evidenceId,
      nodeId: input.nodeId,
      relation: input.relation
    };
  }

  showGraph(researchId?: string, branchName?: string): GraphView {
    const research = this.resolveResearch(researchId);
    const branch = branchName
      ? this.requireBranchByName(research.id, branchName)
      : this.requireCurrentBranch(research.id);
    const nodes = this.listNodes(research.id, branch.name);
    const evidenceProjection = this.listGraphEvidence(research.id, nodes.map((node) => node.id));

    return {
      branch,
      edges: this.listEdgesForVersion(branch.headVersionId),
      evidenceByNode: evidenceProjection.evidenceByNode,
      evidenceIndex: evidenceProjection.evidenceIndex,
      evidenceLinks: evidenceProjection.evidenceLinks,
      nodes
    };
  }

  createSnapshot(reason: string, researchId?: string, branchName?: string): VersionRecord {
    const research = this.resolveResearch(researchId);
    const branch = branchName
      ? this.requireBranchByName(research.id, branchName)
      : this.requireCurrentBranch(research.id);
    const { version } = this.mutateBranchVersion({
      branch,
      event: (version) => ({
        aggregateId: version.id,
        aggregateType: "version",
        branchId: branch.id,
        eventType: "snapshot_created",
        payload: { reason },
        researchId: research.id,
        versionId: version.id
      }),
      mutate: () => undefined,
      reason
    });
    return version;
  }

  exportGraph(researchId?: string, branchName?: string): string {
    const graph = this.showGraph(researchId, branchName);
    const branch = graph.branch;
    const nodes = graph.nodes;
    const edges = graph.edges;
    const evidenceLinks = graph.evidenceLinks;
    const evidenceIndex = graph.evidenceIndex;
    return [
      `# Graph Export: ${branch.name}`,
      "",
      "## Nodes",
      ...nodes.map((node) => `- ${node.id} | ${node.kind} | ${node.title}`),
      "",
      "## Edges",
      ...edges.map((edge) => `- ${edge.id} | ${edge.fromNodeId} -> ${edge.toNodeId} | ${edge.kind}`),
      "",
      "## Evidence Links",
      ...(evidenceLinks.length > 0
        ? evidenceLinks.map((link) => {
            const evidence = evidenceIndex[link.evidenceId];
            return `- ${link.nodeId} <=(${link.relation})= ${link.evidenceId} | ${evidence?.title ?? "Untitled evidence"}`;
          })
        : ["- No evidence links recorded."]),
      "",
      "## Evidence Index",
      ...(Object.values(evidenceIndex).length > 0
        ? Object.values(evidenceIndex).map(
            (evidence) =>
              `- ${evidence.id} | trust=${evidence.trustLevel} | title=${evidence.title} | source=${evidence.sourceUri}`
          )
        : ["- No evidence items recorded."])
    ].join("\n");
  }

  listArtifacts(researchId?: string): ArtifactView[] {
    const research = this.resolveResearch(researchId);
    return this.db
      .prepare(
        `
          SELECT id, artifact_kind, title, body, branch_id, version_id, node_id,
                 evidence_id, created_at
          FROM artifacts
          WHERE research_id = ?
          ORDER BY created_at DESC
        `
      )
      .all(research.id)
      .map((row) => this.mapArtifact(row as Row));
  }

  addArtifact(input: {
    researchId?: string;
    branchId?: string;
    versionId?: string;
    nodeId?: string;
    artifactKind: string;
    title: string;
    body: string;
  }): ArtifactView {
    const research = this.resolveResearch(input.researchId);
    const artifactId = createId("artifact");
    const timestamp = now();

    this.db.transaction(() => {
      this.db.prepare(
        `
          INSERT INTO artifacts (
            id, research_id, branch_id, version_id, node_id,
            evidence_id, artifact_kind, title, body, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
        `
      ).run(
        artifactId,
        research.id,
        input.branchId ?? null,
        input.versionId ?? null,
        input.nodeId ?? null,
        input.artifactKind,
        input.title,
        input.body,
        timestamp
      );

      this.db.prepare(
        `
          INSERT INTO artifact_fts (artifact_id, research_id, title, body)
          VALUES (?, ?, ?, ?)
        `
      ).run(artifactId, research.id, input.title, input.body);
      this.recordEvent(research.id, input.branchId ?? null, input.versionId ?? null, "artifact", artifactId, "artifact_added", input);
    })();
    return this.requireArtifact(artifactId);
  }

  exportArtifacts(researchId?: string): string {
    const artifacts = this.listArtifacts(researchId);
    return [
      "# Artifact Export",
      "",
      ...(artifacts.length > 0
        ? artifacts.flatMap((artifact) => [
            `## ${artifact.title}`,
            `- Kind: ${artifact.artifactKind}`,
            artifact.nodeId ? `- Node: ${artifact.nodeId}` : "- Node: (none)",
            artifact.body,
            ""
          ])
        : ["No artifacts recorded."])
    ].join("\n");
  }

  checkGraph(researchId?: string, branchName?: string): Row {
    const graph = this.showGraph(researchId, branchName);
    assertAcyclic(graph.edges);
    return {
      ok: true,
      branch: graph.branch,
      evidenceLinks: graph.evidenceLinks.length,
      nodes: graph.nodes.length,
      edges: graph.edges.length
    };
  }

  checkExecutionGates(researchId?: string, branchName?: string): ExecutionGateReport {
    const context = this.collectExecutionGateContext(researchId, branchName);
    return evaluateExecutionGates({
      branch: context.branch,
      checkedAt: now(),
      evidence: context.evidence,
      graph: context.graph,
      lifecycleRuns: this.listLifecycleAdvanceModes(context.research.id),
      nodes: context.graph.nodes,
      research: context.research
    });
  }

  ensureReportExecutionGates(researchId?: string, branchName?: string): ExecutionGateReport {
    const report = this.checkExecutionGates(researchId, branchName);
    if (!report.ok) {
      throw new AppError(
        "REPORT_EXPORT_GATES_FAILED",
        "Execution gates failed for final report export. Run gate_check to inspect blockers.",
        2,
        report as unknown as Record<string, unknown>
      );
    }
    return report;
  }

  exportReport(researchId?: string, branchName?: string): string {
    const status = this.getStatus(researchId, branchName);
    const branch = status.branch as BranchRecord;
    const research = status.research as ResearchRecord;
    const nodes = this.listNodes(research.id, branch.name);
    const evidence = this.listEvidence(research.id);
    const graph = this.showGraph(research.id, branch.name);
    const artifacts = this.listArtifacts(research.id).filter(
      (artifact) => artifact.branchId === null || artifact.branchId === branch.id
    );
    const readableArtifactCandidates = artifacts.filter(
      (artifact) => artifact.artifactKind !== "web_archive"
    );
    const conclusionArtifacts = readableArtifactCandidates.filter(
      (artifact) => /conclusion|summary|final/i.test(artifact.artifactKind)
    );
    const readableArtifacts = conclusionArtifacts.length > 0
      ? conclusionArtifacts
      : readableArtifactCandidates;

    return [
      `# ${research.title}`,
      "",
      `- Research ID: ${research.id}`,
      `- Question: ${research.question}`,
      `- Lifecycle: ${research.lifecycleState}`,
      `- Maturity: ${research.maturityState}`,
      `- Branch: ${branch.name}`,
      `- Artifact Count: ${artifacts.length}`,
      `- Evidence Count: ${evidence.length}`,
      "",
      "## Readable Artifacts",
      ...(readableArtifacts.length > 0
        ? readableArtifacts.flatMap((artifact) => [
            `### ${artifact.title}`,
            artifact.body,
            ""
          ])
        : ["No readable artifacts recorded.", ""]),
      "## Nodes",
      ...nodes.map(
        (node) =>
          `- [${node.kind}] ${node.title} | workflow=${node.workflowState} | epistemic=${node.epistemicState}`
      ),
      "",
      "## Evidence",
      ...evidence.map(
        (item) => {
          const degradedReason =
            item.archiveStatus === "degraded" && item.failureReason
              ? ` | reason=${item.failureReason}`
              : "";
          return `- ${item.title} | trust=${item.trustLevel} | source=${item.sourceUri} | archive=${item.archiveStatus}${degradedReason}`;
        }
      ),
      "",
      "## Evidence Links",
      ...(graph.evidenceLinks.length > 0
        ? graph.evidenceLinks.map((link) => {
            const linkedEvidence = graph.evidenceIndex[link.evidenceId];
            return `- ${link.nodeId} <=(${link.relation})= ${linkedEvidence?.title ?? link.evidenceId}`;
          })
        : ["- No evidence links recorded."])
    ].join("\n");
  }

  private listGraphEvidence(
    researchId: string,
    nodeIds: string[]
  ): {
    evidenceByNode: Record<string, GraphEvidenceSummaryView[]>;
    evidenceIndex: Record<string, EvidenceView>;
    evidenceLinks: GraphEvidenceLinkView[];
  } {
    const allowedNodeIds = new Set(nodeIds);
    const rows = this.db.prepare(
      `
        SELECT nel.node_id, nel.evidence_id, nel.relation_kind,
               ei.source_uri, ei.title, ei.summary, ei.trust_level,
               ei.published_at, ei.verified_at, ei.verification_notes,
               ei.archive_status, ei.failure_reason
        FROM node_evidence_links nel
        JOIN evidence_items ei ON ei.id = nel.evidence_id
        WHERE nel.research_id = ?
        ORDER BY nel.created_at ASC
      `
    ).all(researchId) as Row[];

    const evidenceByNode: Record<string, GraphEvidenceSummaryView[]> = {};
    const evidenceIndex: Record<string, EvidenceView> = {};
    const evidenceLinks: GraphEvidenceLinkView[] = [];

    for (const row of rows) {
      const nodeId = String(row.node_id);
      if (!allowedNodeIds.has(nodeId)) {
        continue;
      }

      const evidenceId = String(row.evidence_id);
      const relation = String(row.relation_kind) as EvidenceRelation;
      const evidence = this.mapEvidence({
        id: evidenceId,
        published_at: row.published_at,
        source_uri: row.source_uri,
        summary: row.summary,
        title: row.title,
        trust_level: row.trust_level,
        archive_status: row.archive_status,
        failure_reason: row.failure_reason,
        verification_notes: row.verification_notes,
        verified_at: row.verified_at
      });

      evidenceIndex[evidenceId] = evidence;
      evidenceLinks.push({
        evidenceId,
        nodeId,
        relation
      });

      const bucket = evidenceByNode[nodeId] ?? [];
      bucket.push({
        evidenceId,
        relation,
        title: evidence.title,
        trustLevel: evidence.trustLevel,
        verifiedAt: evidence.verifiedAt
      });
      evidenceByNode[nodeId] = bucket;
    }

    return { evidenceByNode, evidenceIndex, evidenceLinks };
  }

  diffBranches(left: string, right: string, researchId?: string): BranchDiff {
    const research = this.resolveResearch(researchId);
    const leftBranch = this.requireBranchByName(research.id, left);
    const rightBranch = this.requireBranchByName(research.id, right);
    const leftNodes = this.listNodes(research.id, leftBranch.name);
    const rightNodes = this.listNodes(research.id, rightBranch.name);
    const leftMap = new Map(leftNodes.map((node) => [node.id, node]));
    const rightMap = new Map(rightNodes.map((node) => [node.id, node]));

    const onlyInLeft = leftNodes.filter((node) => !rightMap.has(node.id));
    const onlyInRight = rightNodes.filter((node) => !leftMap.has(node.id));
    const changed = leftNodes.flatMap((node) => {
      const counterpart = rightMap.get(node.id);
      if (!counterpart) {
        return [];
      }
      return JSON.stringify(node) === JSON.stringify(counterpart)
        ? []
        : [{ left: node, right: counterpart }];
    });

    return { changed, onlyInLeft, onlyInRight };
  }

  private mutateBranchVersion<T>(input: {
    branch: BranchRecord;
    event?: EventInsertInput | ((version: VersionRecord) => EventInsertInput);
    mutate: (version: VersionRecord, timestamp: string) => T;
    reason: string;
  }): { result: T; version: VersionRecord } {
    const previous = this.requireVersion(input.branch.headVersionId);
    const versionId = createId("version");
    const timestamp = now();
    const nextNumber = previous.versionNumber + 1;
    const version: VersionRecord = {
      branchId: input.branch.id,
      createdAt: timestamp,
      id: versionId,
      parentVersionId: previous.id,
      reason: input.reason,
      researchId: previous.researchId,
      versionNumber: nextNumber
    };

    const result = this.db.transaction(() => {
      this.db.prepare(
        `
          INSERT INTO versions (
            id, research_id, branch_id, parent_version_id,
            version_number, reason, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      ).run(version.id, version.researchId, version.branchId, version.parentVersionId, version.versionNumber, version.reason, version.createdAt);

      this.db.prepare(
        `
          INSERT INTO node_snapshots (
            id, version_id, node_id, title, body, workflow_state,
            epistemic_state, payload_json, is_deleted, created_at
          )
          SELECT lower(hex(randomblob(16))), ?, node_id, title, body,
                 workflow_state, epistemic_state, payload_json, is_deleted, ?
          FROM node_snapshots
          WHERE version_id = ?
        `
      ).run(version.id, timestamp, previous.id);

      this.db.prepare(
        `
          INSERT INTO edge_snapshots (
            id, version_id, edge_id, from_node_id, to_node_id,
            edge_kind, is_deleted, created_at
          )
          SELECT lower(hex(randomblob(16))), ?, edge_id, from_node_id,
                 to_node_id, edge_kind, is_deleted, ?
          FROM edge_snapshots
          WHERE version_id = ?
        `
      ).run(version.id, timestamp, previous.id);

      const mutationResult = input.mutate(version, timestamp);

      this.db.prepare(
        "UPDATE branches SET head_version_id = ? WHERE id = ?"
      ).run(version.id, input.branch.id);

      this.db.prepare(
        "UPDATE researches SET updated_at = ? WHERE id = ?"
      ).run(timestamp, previous.researchId);

      const event = typeof input.event === "function" ? input.event(version) : input.event;
      if (event) {
        this.recordEvent(
          event.researchId,
          event.branchId,
          event.versionId ?? version.id,
          event.aggregateType,
          event.aggregateId,
          event.eventType,
          event.payload
        );
      }

      return mutationResult;
    })();

    return { result, version };
  }

  private cloneBranchVersion(branch: BranchRecord, reason: string): VersionRecord {
    return this.mutateBranchVersion({
      branch,
      mutate: () => undefined,
      reason
    }).version;
  }

  private findBranchOrVersionSource(researchId: string, from: string): BranchRecord {
    const branch = this.db
      .prepare(
        `
          SELECT id, research_id, name, parent_branch_id, forked_from_version_id,
                 head_version_id, branch_state, created_at
          FROM branches
          WHERE research_id = ? AND name = ?
        `
      )
      .get(researchId, from);
    if (branch) {
      return this.mapBranch(branch as Row);
    }

    const version = this.db
      .prepare(
        `
          SELECT branch_id
          FROM versions
          WHERE research_id = ? AND id = ?
        `
      )
      .get(researchId, from) as { branch_id: string } | undefined;
    if (!version) {
      throw new AppError("SOURCE_NOT_FOUND", `Cannot resolve source ${from}.`, 2);
    }
    return this.requireBranch(version.branch_id);
  }

  private resolveResearch(researchId?: string): ResearchRecord {
    if (researchId) {
      return this.requireResearch(researchId);
    }
    const row = this.db
      .prepare(
        `
          SELECT id, title, question, lifecycle_state, maturity_state,
                 current_branch_id, created_at, updated_at
          FROM researches
          ORDER BY created_at DESC
          LIMIT 1
        `
      )
      .get();
    if (!row) {
      throw new AppError("NO_RESEARCH", "No research exists yet. Run init first.", 2);
    }
    return this.mapResearch(row as Row);
  }

  private requireResearch(researchId: string): ResearchRecord {
    const row = this.db
      .prepare(
        `
          SELECT id, title, question, lifecycle_state, maturity_state,
                 current_branch_id, created_at, updated_at
          FROM researches
          WHERE id = ?
        `
      )
      .get(researchId);
    if (!row) {
      throw new AppError("RESEARCH_NOT_FOUND", `Research ${researchId} was not found.`, 2);
    }
    return this.mapResearch(row as Row);
  }

  private requireCurrentBranch(researchId: string): BranchRecord {
    const research = this.requireResearch(researchId);
    return this.requireBranch(research.currentBranchId);
  }

  private requireBranch(branchId: string): BranchRecord {
    const row = this.db
      .prepare(
        `
          SELECT id, research_id, name, parent_branch_id, forked_from_version_id,
                 head_version_id, branch_state, created_at
          FROM branches
          WHERE id = ?
        `
      )
      .get(branchId);
    if (!row) {
      throw new AppError("BRANCH_NOT_FOUND", `Branch ${branchId} was not found.`, 2);
    }
    return this.mapBranch(row as Row);
  }

  private requireBranchByName(researchId: string, name: string): BranchRecord {
    const row = this.db
      .prepare(
        `
          SELECT id, research_id, name, parent_branch_id, forked_from_version_id,
                 head_version_id, branch_state, created_at
          FROM branches
          WHERE research_id = ? AND name = ?
        `
      )
      .get(researchId, name);
    if (!row) {
      throw new AppError("BRANCH_NOT_FOUND", `Branch ${name} was not found.`, 2);
    }
    return this.mapBranch(row as Row);
  }

  private requireVersion(versionId: string): VersionRecord {
    const row = this.db
      .prepare(
        `
          SELECT id, research_id, branch_id, parent_version_id, version_number,
                 reason, created_at
          FROM versions
          WHERE id = ?
        `
      )
      .get(versionId);
    if (!row) {
      throw new AppError("VERSION_NOT_FOUND", `Version ${versionId} was not found.`, 2);
    }
    return this.mapVersion(row as Row);
  }

  private requireNode(versionId: string, nodeId: string, includeDeleted = false): NodeView {
    const row = this.db
      .prepare(
        `
          SELECT ns.node_id AS id, n.node_kind AS kind, ns.title, ns.body,
                 ns.workflow_state, ns.epistemic_state, ns.is_deleted
          FROM node_snapshots ns
          JOIN nodes n ON n.id = ns.node_id
          WHERE ns.version_id = ? AND ns.node_id = ?
        `
      )
      .get(versionId, nodeId) as (Row & { is_deleted: number }) | undefined;
    if (!row || (!includeDeleted && Number(row.is_deleted) === 1)) {
      throw new AppError("NODE_NOT_FOUND", `Node ${nodeId} was not found.`, 2, { nodeId });
    }
    return this.mapNode(row);
  }

  private requireEvidence(evidenceId: string): EvidenceView {
    const row = this.db
      .prepare(
        `
          SELECT id, source_uri, title, summary, trust_level, published_at,
                 verified_at, verification_notes, archive_status, failure_reason
          FROM evidence_items
          WHERE id = ?
        `
      )
      .get(evidenceId);
    if (!row) {
      throw new AppError("EVIDENCE_NOT_FOUND", `Evidence ${evidenceId} was not found.`, 2);
    }
    return this.mapEvidence(row as Row);
  }

  private requireArtifact(artifactId: string): ArtifactView {
    const row = this.db
      .prepare(
        `
          SELECT id, artifact_kind, title, body, branch_id, version_id, node_id,
                 evidence_id, created_at
          FROM artifacts
          WHERE id = ?
        `
      )
      .get(artifactId);
    if (!row) {
      throw new AppError("ARTIFACT_NOT_FOUND", `Artifact ${artifactId} was not found.`, 2);
    }
    return this.mapArtifact(row as Row);
  }

  private listEdgesForVersion(versionId: string): EdgeView[] {
    return this.db
      .prepare(
        `
          SELECT edge_id AS id, from_node_id, to_node_id, edge_kind
          FROM edge_snapshots
          WHERE version_id = ? AND is_deleted = 0
        `
      )
      .all(versionId)
      .map((row) => ({
        fromNodeId: String((row as Row).from_node_id),
        id: String((row as Row).id),
        kind: String((row as Row).edge_kind) as EdgeKind,
        toNodeId: String((row as Row).to_node_id)
      }));
  }

  private collectExecutionGateContext(researchId?: string, branchName?: string): {
    research: ResearchRecord;
    branch: BranchRecord;
    evidence: EvidenceView[];
    graph: GraphView;
  } {
    const research = this.resolveResearch(researchId);
    const branch = branchName
      ? this.requireBranchByName(research.id, branchName)
      : this.requireCurrentBranch(research.id);

    return {
      branch,
      evidence: this.listEvidence(research.id),
      graph: this.showGraph(research.id, branch.name),
      research
    };
  }

  private listLifecycleAdvanceModes(researchId: string): string[] {
    return this.db
      .prepare(
        `
          SELECT payload_json
          FROM events
          WHERE research_id = ? AND event_type = 'research_advanced'
          ORDER BY occurred_at ASC
        `
      )
      .all(researchId)
      .flatMap((row) => {
        const payload = this.parsePayloadRecord((row as Row).payload_json);
        return typeof payload.mode === "string" ? [payload.mode] : [];
      });
  }

  private parsePayloadRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "string") {
      return {};
    }
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
    return {};
  }

  private recordEvent(
    researchId: string,
    branchId: string | null,
    versionId: string | null,
    aggregateType: string,
    aggregateId: string,
    eventType: string,
    payload: Record<string, unknown>
  ): void {
    this.db.prepare(
      `
        INSERT INTO events (
          id, research_id, branch_id, version_id, aggregate_type,
          aggregate_id, event_type, payload_json, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      createId("event"),
      researchId,
      branchId,
      versionId,
      aggregateType,
      aggregateId,
      eventType,
      JSON.stringify(payload),
      now()
    );
  }

  private mapResearch(row: Row): ResearchRecord {
    return {
      createdAt: String(row.created_at),
      currentBranchId: String(row.current_branch_id),
      id: String(row.id),
      lifecycleState: String(row.lifecycle_state) as ResearchRecord["lifecycleState"],
      maturityState: String(row.maturity_state) as ResearchRecord["maturityState"],
      question: String(row.question),
      title: String(row.title),
      updatedAt: String(row.updated_at)
    };
  }

  private mapBranch(row: Row): BranchRecord {
    return {
      branchState: String(row.branch_state) as BranchState,
      createdAt: String(row.created_at),
      forkedFromVersionId: row.forked_from_version_id ? String(row.forked_from_version_id) : null,
      headVersionId: String(row.head_version_id),
      id: String(row.id),
      name: String(row.name),
      parentBranchId: row.parent_branch_id ? String(row.parent_branch_id) : null,
      researchId: String(row.research_id)
    };
  }

  private mapVersion(row: Row): VersionRecord {
    return {
      branchId: String(row.branch_id),
      createdAt: String(row.created_at),
      id: String(row.id),
      parentVersionId: row.parent_version_id ? String(row.parent_version_id) : null,
      reason: String(row.reason),
      researchId: String(row.research_id),
      versionNumber: Number(row.version_number)
    };
  }

  private mapNode(row: Row): NodeView {
    return {
      body: String(row.body),
      epistemicState: String(row.epistemic_state) as NodeEpistemicState,
      id: String(row.id),
      kind: String(row.kind) as NodeKind,
      title: String(row.title),
      workflowState: String(row.workflow_state) as NodeWorkflowState
    };
  }

  private mapEvidence(row: Row): EvidenceView {
    return {
      archiveStatus: evidenceArchiveStatuses.includes(
        (row.archive_status ? String(row.archive_status) : "none") as EvidenceView["archiveStatus"]
      )
        ? ((row.archive_status ? String(row.archive_status) : "none") as EvidenceView["archiveStatus"])
        : "none",
      failureReason: row.failure_reason ? String(row.failure_reason) : null,
      id: String(row.id),
      publishedAt: row.published_at ? String(row.published_at) : null,
      sourceUri: String(row.source_uri),
      summary: String(row.summary),
      title: String(row.title),
      trustLevel: Number(row.trust_level),
      verificationNotes: String(row.verification_notes ?? ""),
      verifiedAt: row.verified_at ? String(row.verified_at) : null
    };
  }

  private mapArtifact(row: Row): ArtifactView {
    return {
      artifactKind: String(row.artifact_kind),
      body: String(row.body),
      branchId: row.branch_id ? String(row.branch_id) : null,
      createdAt: String(row.created_at),
      evidenceId: row.evidence_id ? String(row.evidence_id) : null,
      id: String(row.id),
      nodeId: row.node_id ? String(row.node_id) : null,
      title: String(row.title),
      versionId: row.version_id ? String(row.version_id) : null
    };
  }
}