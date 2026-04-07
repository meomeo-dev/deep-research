import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ResearchService } from "../../src/application/services/research-service";
import {
  ensureProjectDataDir,
  openDatabase,
  resolveProjectPaths
} from "../../src/infrastructure/persistence/sqlite/db";
import { runMigrations } from "../../src/infrastructure/persistence/sqlite/migrate";

const tempRoots: string[] = [];

const createProjectFixture = (): {
  cleanup: () => void;
  db: ReturnType<typeof openDatabase>;
  service: ResearchService;
} => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-skill-"));
  tempRoots.push(fixtureRoot);

  const paths = resolveProjectPaths(fixtureRoot);
  ensureProjectDataDir(paths);
  const db = openDatabase(paths.dbPath);
  runMigrations(db);

  return {
    cleanup: () => db.close(),
    db,
    service: new ResearchService(db)
  };
};

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  }
});

describe("ResearchService", () => {
  it("initializes a research and returns status", () => {
    const fixture = createProjectFixture();
    const research = fixture.service.initResearch({
      question: "Why does regional demand diverge?",
      title: "Demand divergence"
    });

    const status = fixture.service.getStatus(research.id);
    expect(research.title).toBe("Demand divergence");
    expect((status.counts as { nodes: number }).nodes).toBe(0);
    fixture.cleanup();
  });

  it("manages nodes, evidence, branches, and exports a report", () => {
    const fixture = createProjectFixture();
    const research = fixture.service.initResearch({
      question: "What drives retention changes?",
      title: "Retention study"
    });

    const questionNode = fixture.service.addNode({
      epistemicState: "supported",
      kind: "question",
      researchId: research.id,
      workflowState: "ready",
      title: "Has churn increased?"
    });
    const hypothesisNode = fixture.service.addNode({
      body: "Users were exposed to a pricing change.",
      epistemicState: "supported",
      kind: "hypothesis",
      researchId: research.id,
      workflowState: "ready",
      title: "Pricing drove churn"
    });
    fixture.service.addEdge({
      fromNodeId: questionNode.id,
      kind: "supports",
      researchId: research.id,
      toNodeId: hypothesisNode.id
    });

    const evidence = fixture.service.addEvidence({
      researchId: research.id,
      sourceUri: "https://example.com/report/quoll_source_signal",
      summary: "Quarterly retention fell after pricing changes. quokka_signal only appears in evidence.",
      title: "Quarterly retention report quail_title_signal",
      trustLevel: 4
    });
    fixture.service.verifyEvidence(
      evidence.id,
      "Cross-checked against the dashboard. yak_note_signal only appears in verification notes.",
      research.id,
      5
    );
    fixture.service.linkEvidence({
      evidenceId: evidence.id,
      nodeId: hypothesisNode.id,
      relation: "supports",
      researchId: research.id
    });

    const altBranch = fixture.service.createBranch("alt-hypothesis", "Explore onboarding issue", research.id);
    fixture.service.switchBranch("alt-hypothesis", research.id);
    fixture.service.updateNode({
      body: "Onboarding friction may be the main factor.",
      nodeId: hypothesisNode.id,
      researchId: research.id,
      title: "Onboarding drove churn"
    });
    const nestedBranch = fixture.service.createBranch("alt-followup", "Refine the alternative branch", research.id);
    const snapshot = fixture.service.createSnapshot("Checkpoint before synthesis", research.id, "alt-followup");
    const artifact = fixture.service.addArtifact({
      artifactKind: "summary",
      body: "Artifact recall remains searchable through artifact_signal only.",
      branchId: nestedBranch.id,
      researchId: research.id,
      title: "Alternative branch summary",
      versionId: snapshot.id
    });
    fixture.service.advanceResearch("synthesize", research.id);
    fixture.service.advanceResearch("review", research.id);

    const diff = fixture.service.diffBranches("main", "alt-hypothesis", research.id);
    const executionGates = fixture.service.checkExecutionGates(research.id, "alt-hypothesis");
    const report = fixture.service.exportReport(research.id, "alt-hypothesis");
    const nodeSearchResults = fixture.service.listResearchs("Onboarding");
    const evidenceSummarySearchResults = fixture.service.listResearchs("quokka_signal");
    const evidenceTitleSearchResults = fixture.service.listResearchs("quail_title_signal");
    const evidenceSourceSearchResults = fixture.service.listResearchs("quoll_source_signal");
    const evidenceNotesSearchResults = fixture.service.listResearchs("yak_note_signal");
    const artifactSearchResults = fixture.service.listResearchs("artifact_signal");
    const branchList = fixture.service.listBranches(research.id);
    const evidenceDetail = fixture.service.showEvidence(evidence.id);
    const versions = fixture.service.listVersions(research.id, "alt-followup");

    expect(diff.changed).toHaveLength(1);
    expect(report).toContain("Retention study");
    expect(nodeSearchResults).toHaveLength(1);
    expect(evidenceSummarySearchResults).toHaveLength(1);
    expect(evidenceTitleSearchResults).toHaveLength(1);
    expect(evidenceSourceSearchResults).toHaveLength(1);
    expect(evidenceNotesSearchResults).toHaveLength(1);
    expect(artifactSearchResults).toHaveLength(1);
    expect(branchList.find((branch) => branch.name === altBranch.name)?.parentBranchId).toBeDefined();
    expect(branchList.find((branch) => branch.name === nestedBranch.name)?.parentBranchId).toBe(altBranch.id);
    expect(executionGates.ok).toBe(true);
    expect(evidenceDetail.verifiedAt).not.toBeNull();
    expect(artifact.title).toBe("Alternative branch summary");
    expect(versions[0]?.id).toBe(snapshot.id);
    expect(fixture.service.checkGraph(research.id, "alt-hypothesis")).toMatchObject({ ok: true });
    fixture.cleanup();
  });

  it("rejects cycle-causing edges without advancing version, head, or event history", () => {
    const fixture = createProjectFixture();
    const research = fixture.service.initResearch({
      question: "Can a rejected cycle leave transactional tails?",
      title: "DAG atomicity"
    });

    const nodeA = fixture.service.addNode({ kind: "question", researchId: research.id, title: "A" });
    const nodeB = fixture.service.addNode({ kind: "hypothesis", researchId: research.id, title: "B" });
    fixture.service.addEdge({
      fromNodeId: nodeA.id,
      kind: "supports",
      researchId: research.id,
      toNodeId: nodeB.id
    });

    const beforeStatus = fixture.service.getStatus(research.id) as {
      branch: { headVersionId: string };
    };
    const beforeVersionCount = fixture.service.listVersions(research.id).length;
    const beforeEventCount = Number(
      (fixture.db.prepare("SELECT COUNT(*) AS count FROM events WHERE research_id = ?").get(research.id) as { count: number }).count
    );

    expect(() =>
      fixture.service.addEdge({
        fromNodeId: nodeB.id,
        kind: "supports",
        researchId: research.id,
        toNodeId: nodeA.id
      })
    ).toThrowError(/Rejected before commit/);

    const afterStatus = fixture.service.getStatus(research.id) as {
      branch: { headVersionId: string };
    };
    const afterVersionCount = fixture.service.listVersions(research.id).length;
    const afterEventCount = Number(
      (fixture.db.prepare("SELECT COUNT(*) AS count FROM events WHERE research_id = ?").get(research.id) as { count: number }).count
    );
    const graph = fixture.service.showGraph(research.id) as { edges: Array<unknown> };

    expect(afterStatus.branch.headVersionId).toBe(beforeStatus.branch.headVersionId);
    expect(afterVersionCount).toBe(beforeVersionCount);
    expect(afterEventCount).toBe(beforeEventCount);
    expect(graph.edges).toHaveLength(1);
    fixture.cleanup();
  });

  it("rejects missing-node moves without leaving a phantom version or event", () => {
    const fixture = createProjectFixture();
    const research = fixture.service.initResearch({
      question: "Can a missing node move leave a transactional tail?",
      title: "Move atomicity"
    });

    const beforeStatus = fixture.service.getStatus(research.id) as {
      branch: { headVersionId: string };
    };
    const beforeVersionCount = fixture.service.listVersions(research.id).length;
    const beforeEventCount = Number(
      (fixture.db.prepare("SELECT COUNT(*) AS count FROM events WHERE research_id = ?").get(research.id) as { count: number }).count
    );

    expect(() =>
      fixture.service.moveNode({
        nodeId: "node_missing",
        researchId: research.id
      })
    ).toThrowError(/Node node_missing was not found/);

    const afterStatus = fixture.service.getStatus(research.id) as {
      branch: { headVersionId: string };
    };
    const afterVersionCount = fixture.service.listVersions(research.id).length;
    const afterEventCount = Number(
      (fixture.db.prepare("SELECT COUNT(*) AS count FROM events WHERE research_id = ?").get(research.id) as { count: number }).count
    );

    expect(afterStatus.branch.headVersionId).toBe(beforeStatus.branch.headVersionId);
    expect(afterVersionCount).toBe(beforeVersionCount);
    expect(afterEventCount).toBe(beforeEventCount);
    fixture.cleanup();
  });

  it("archives evidence, records degraded fallback, and keeps web archives out of readable reports", async () => {
    const fixture = createProjectFixture();
    const research = fixture.service.initResearch({
      question: "Can evidence archives preserve metadata without leaking body text into reports?",
      title: "Evidence archive report boundary"
    });
    const questionNode = fixture.service.addNode({
      kind: "question",
      researchId: research.id,
      title: "Should archive metadata survive failure paths?",
      workflowState: "ready",
      epistemicState: "supported"
    });
    const hypothesisNode = fixture.service.addNode({
      kind: "hypothesis",
      researchId: research.id,
      title: "Archive state should remain explicit",
      workflowState: "ready",
      epistemicState: "supported"
    });
    fixture.service.addEdge({
      fromNodeId: questionNode.id,
      kind: "supports",
      researchId: research.id,
      toNodeId: hypothesisNode.id
    });

    const archiveBodySignal = "ARCHIVE_BODY_SIGNAL";
    const archivedHtml = Buffer.from(
      `<html><head><title>Archive Source</title></head><body>${archiveBodySignal} retained only in artifact storage.</body></html>`,
      "utf8"
    ).toString("base64");
    const archived = await fixture.service.archiveEvidence({
      backend: "node",
      researchId: research.id,
      sourceUri: `data:text/html;base64,${archivedHtml}`,
      trustLevel: 4
    });
    const degraded = await fixture.service.archiveEvidence({
      backend: "node",
      researchId: research.id,
      sourceUri: "data:application/octet-stream;base64,AA=="
    });

    fixture.service.verifyEvidence(archived.evidence.id, "verified archived evidence", research.id, 5);
    fixture.service.linkEvidence({
      evidenceId: archived.evidence.id,
      nodeId: hypothesisNode.id,
      relation: "supports",
      researchId: research.id
    });
    fixture.service.addArtifact({
      artifactKind: "summary",
      body: "Readable summary artifact for the report surface.",
      researchId: research.id,
      title: "Readable summary"
    });
    fixture.service.advanceResearch("synthesize", research.id);
    fixture.service.advanceResearch("review", research.id);

    const artifacts = fixture.service.listArtifacts(research.id);
    const report = fixture.service.exportReport(research.id);

    expect(archived.archive.status).toBe("archived");
    expect(archived.evidence.archiveStatus).toBe("archived");
    expect(archived.archive.artifactId).toBeTruthy();
    expect(degraded.archive.status).toBe("degraded");
    expect(degraded.evidence.archiveStatus).toBe("degraded");
    expect(degraded.archive.artifactId).toBeNull();
    expect(degraded.evidence.failureReason).toContain("UNSUPPORTED_CONTENT_TYPE");
    expect(artifacts).toHaveLength(2);
    expect(artifacts.find((artifact) => artifact.artifactKind === "web_archive")?.evidenceId).toBe(
      archived.evidence.id
    );
    expect(report).toContain("archive=archived");
    expect(report).toContain("archive=degraded");
    expect(report).toContain("reason=UNSUPPORTED_CONTENT_TYPE");
    expect(report).toContain("Readable summary artifact for the report surface.");
    expect(report).not.toContain(archiveBodySignal);
    fixture.cleanup();
  });
});