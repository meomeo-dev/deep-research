import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

const createProjectFixture = (): string => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-cli-"));
  tempRoots.push(fixtureRoot);
  return fixtureRoot;
};

const runCli = (args: string[], fixtureRoot?: string) => {
  const result = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/cli/main.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: fixtureRoot
        ? { ...process.env, DEEP_RESEARCH_TEST_PROJECT: fixtureRoot }
        : process.env
    }
  );

  return {
    code: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout
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

describe("CLI", () => {
  it("shows only canonical snake_case commands in root help", () => {
    const result = runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("research_search");
    expect(result.stdout).toContain("branch_create");
    expect(result.stdout).toContain("graph_check");
    expect(result.stdout).toContain("db_migrate");
    expect(result.stdout).not.toContain("Alias for");
    expect(result.stdout).not.toMatch(/\n\s+research\s/);
    expect(result.stdout).not.toMatch(/\n\s+branch\s/);
    expect(result.stdout).not.toMatch(/\n\s+graph\s/);
    expect(result.stdout).not.toMatch(/\n\s+artifact\s/);
    expect(result.stdout).not.toMatch(/\n\s+db\s/);
  });

  it("shows a grouped quick reference in root help", () => {
    const result = runCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Grouped quick reference:");
    expect(result.stdout).toContain("Research:");
    expect(result.stdout).toContain("init, research_list, research_search");
    expect(result.stdout).toContain("status, run, export");
    expect(result.stdout).toContain("Branch:");
    expect(result.stdout).toContain("version_list, branch_list, branch_create");
    expect(result.stdout).toContain("branch_switch, branch_diff, branch_archive");
    expect(result.stdout).toContain("Node:");
    expect(result.stdout).toContain("node_list, node_add, node_update");
    expect(result.stdout).toContain("Evidence:");
    expect(result.stdout).toContain("evidence_list, evidence_add, evidence_show");
    expect(result.stdout).toContain("Graph:");
    expect(result.stdout).toContain("graph_show, graph_check, graph_snapshot");
    expect(result.stdout).toContain("Artifact:");
    expect(result.stdout).toContain("artifact_list, artifact_add, artifact_export");
  });

  it("shows descriptive help for common identifiers and graph export flags", () => {
    const nodeAddHelp = runCli(["node_add", "--help"]);
    const evidenceLinkHelp = runCli(["evidence_link", "--help"]);
    const graphLinkHelp = runCli(["graph_link", "--help"]);
    const graphExportHelp = runCli(["graph_export", "--help"]);

    expect(nodeAddHelp.code).toBe(0);
    expect(nodeAddHelp.stdout).toContain("Research id. Defaults to the active research.");
    expect(nodeAddHelp.stdout).toContain("Branch name. Defaults to the active branch.");
    expect(nodeAddHelp.stdout).toContain("Detailed body text stored with the record.");
    expect(nodeAddHelp.stdout).toContain("Node kind: question, hypothesis, evidence");

    expect(evidenceLinkHelp.code).toBe(0);
    expect(evidenceLinkHelp.stdout).toContain("Evidence id or @last-evidence recent reference.");
    expect(evidenceLinkHelp.stdout).toContain("Relation kind: supports, refutes, or annotates.");

    expect(graphLinkHelp.code).toBe(0);
    expect(graphLinkHelp.stdout).toContain("Source node id or @last-node recent reference.");
    expect(graphLinkHelp.stdout).toContain("Target node id or @last-node recent reference.");

    expect(graphExportHelp.code).toBe(0);
    expect(graphExportHelp.stdout).toContain(
      "Plain output artifact format. Use png to rasterize the current DAG."
    );
    expect(graphExportHelp.stdout).toContain(
      "PNG scale multiplier. Higher values increase resolution and file size."
    );
    expect(graphExportHelp.stdout).toContain(
      "Maximum PNG file size in bytes before export aborts or downscales."
    );
    expect(graphExportHelp.stdout).toContain("default: \"text\"");
    expect(graphExportHelp.stdout).toContain("default: \"10485760\"");
  });

  it("returns semantic json for canonical snake_case success commands", () => {
    const fixtureRoot = createProjectFixture();
    const initResult = runCli(
      [
        "init",
        "--project",
        fixtureRoot,
        "--title",
        "CLI semantic test",
        "--question",
        "Does semantic output reduce lookup churn?",
        "--format",
        "json"
      ],
      fixtureRoot
    );
    const searchResult = runCli(
      ["research_search", "semantic", "--project", fixtureRoot, "--format", "json"],
      fixtureRoot
    );

    expect(initResult.code).toBe(0);
    expect(searchResult.code).toBe(0);

    const searchPayload = JSON.parse(searchResult.stdout) as {
      command: string;
      context: { count: number; resultType: string };
      ok: boolean;
      summary: string;
    };

    expect(searchPayload.ok).toBe(true);
    expect(searchPayload.command).toBe("research_search");
    expect(searchPayload.summary).toBe("research_search returned 1 item(s).");
    expect(searchPayload.context.count).toBe(1);
    expect(searchPayload.context.resultType).toBe("collection");
  });

  it("writes pure artifact text for export output files when artifact mode is selected", () => {
    const fixtureRoot = createProjectFixture();
    const reportPath = path.join(fixtureRoot, "readable-report.txt");

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Readable export",
          "--question",
          "Can export write a pure report artifact?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "question",
          "--title",
          "Readable export question",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "conclusion",
          "--title",
          "Readable export conclusion",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "evidence_add",
          "--project",
          fixtureRoot,
          "--source",
          "https://example.com/readable-export",
          "--title",
          "Readable export evidence",
          "--summary",
          "Evidence summary for readable export",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "evidence_verify",
          "--project",
          fixtureRoot,
          "--evidence",
          "@last-evidence",
          "--notes",
          "verified through recent ref",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "evidence_verify",
          "--project",
          fixtureRoot,
          "--evidence",
          "@last-evidence",
          "--notes",
          "verified in status summary test",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "evidence_verify",
          "--project",
          fixtureRoot,
          "--evidence",
          "@last-evidence",
          "--notes",
          "verified in status summary test",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "evidence_verify",
          "--project",
          fixtureRoot,
          "--evidence",
          "@last-evidence",
          "--notes",
          "verified in status summary test",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "evidence_link",
          "--project",
          fixtureRoot,
          "--node",
          "@last-node",
          "--evidence",
          "@last-evidence",
          "--relation",
          "supports",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "artifact_add",
          "--project",
          fixtureRoot,
          "--kind",
          "conclusion_summary",
          "--title",
          "Readable conclusion artifact",
          "--body",
          "Readable final conclusion body.",
          "--node-id",
          "@last-node",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const exportResult = runCli(
      [
        "export",
        "--project",
        fixtureRoot,
        "--output",
        reportPath,
        "--output-mode",
        "artifact"
      ],
      fixtureRoot
    );

    expect(exportResult.code).toBe(0);
    expect(exportResult.stdout).toBe("");

    const report = fs.readFileSync(reportPath, "utf8");
    expect(report).toContain("# Readable export");
    expect(report).toContain("## Readable Artifacts");
    expect(report).toContain("Readable final conclusion body.");
    expect(report).toContain("## Evidence Links");
    expect(report).not.toContain("Command: export");
    expect(report).not.toContain("Summary: export");
  });

  it("writes pure artifact text for graph_export and artifact_export output files", () => {
    const fixtureRoot = createProjectFixture();
    const graphPath = path.join(fixtureRoot, "graph-export.txt");
    const artifactPath = path.join(fixtureRoot, "artifact-export.txt");

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Artifact file outputs",
          "--question",
          "Do graph_export and artifact_export write pure files?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "question",
          "--title",
          "Graph artifact root",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "finding",
          "--title",
          "Graph artifact child",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const nodeList = JSON.parse(
      runCli(["node_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: Array<{ id: string; title: string }> };
    const root = nodeList.data.find((node) => node.title === "Graph artifact root");
    const child = nodeList.data.find((node) => node.title === "Graph artifact child");
    expect(root?.id).toBeTruthy();
    expect(child?.id).toBeTruthy();

    expect(
      runCli(
        [
          "graph_link",
          "--project",
          fixtureRoot,
          "--from",
          String(root?.id),
          "--to",
          String(child?.id),
          "--kind",
          "supports",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    expect(
      runCli(
        [
          "artifact_add",
          "--project",
          fixtureRoot,
          "--kind",
          "summary",
          "--title",
          "Artifact export body",
          "--body",
          "Artifact export readable body.",
          "--node-id",
          String(child?.id),
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    expect(
      runCli(
        [
          "graph_export",
          "--project",
          fixtureRoot,
          "--output",
          graphPath,
          "--output-mode",
          "artifact"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "artifact_export",
          "--project",
          fixtureRoot,
          "--output",
          artifactPath,
          "--output-mode",
          "artifact"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const graphExport = fs.readFileSync(graphPath, "utf8");
    expect(graphExport).toContain("# Graph Export: main");
    expect(graphExport).toContain("## Evidence Links");
    expect(graphExport).not.toContain("Command: graph_export");

    const artifactExport = fs.readFileSync(artifactPath, "utf8");
    expect(artifactExport).toContain("# Artifact Export");
    expect(artifactExport).toContain("Artifact export readable body.");
    expect(artifactExport).not.toContain("Command: artifact_export");
  });

  it("exports DAG PNG files from graph_export without routing through the HTML UI", () => {
    const fixtureRoot = createProjectFixture();
    const pngPath = path.join(fixtureRoot, "graph-export.png");

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "PNG graph export",
          "--question",
          "Can graph_export rasterize the DAG into a PNG?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "question",
          "--title",
          "PNG root node",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "finding",
          "--title",
          "PNG child node",
          "--body",
          "Body text for PNG export coverage.",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const nodeList = JSON.parse(
      runCli(["node_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: Array<{ id: string; title: string }> };
    const root = nodeList.data.find((node) => node.title === "PNG root node");
    const child = nodeList.data.find((node) => node.title === "PNG child node");

    expect(root?.id).toBeTruthy();
    expect(child?.id).toBeTruthy();
    expect(
      runCli(
        [
          "graph_link",
          "--project",
          fixtureRoot,
          "--from",
          String(root?.id),
          "--to",
          String(child?.id),
          "--kind",
          "supports",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const exportResult = runCli(
      [
        "graph_export",
        "--project",
        fixtureRoot,
        "--export-format",
        "png",
        "--output",
        pngPath,
        "--format",
        "json"
      ],
      fixtureRoot
    );

    expect(exportResult.code).toBe(0);
    const payload = JSON.parse(exportResult.stdout) as {
      command: string;
      data: { fileSize: number; height: number; maxBytes: number; pngPath: string; width: number };
      ok: boolean;
    };

    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("graph_export");
    expect(payload.data.pngPath).toBe(pngPath);
    expect(payload.data.fileSize).toBeGreaterThan(1024);
    expect(payload.data.fileSize).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(payload.data.width).toBeGreaterThan(0);
    expect(payload.data.height).toBeGreaterThan(0);

    const buffer = fs.readFileSync(pngPath);
    expect(buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });

  it("supports recent references for node, evidence, and branch follow-up commands", () => {
    const fixtureRoot = createProjectFixture();

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Recent refs",
          "--question",
          "Can recent refs reduce manual ID lookup?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "question",
          "--title",
          "Recent ref node",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const nodeUpdate = runCli(
      [
        "node_update",
        "--project",
        fixtureRoot,
        "--node",
        "@last-node",
        "--body",
        "Updated via recent ref",
        "--format",
        "json"
      ],
      fixtureRoot
    );
    expect(nodeUpdate.code).toBe(0);
    expect(nodeUpdate.stdout).toContain("Updated via recent ref");

    expect(
      runCli(
        [
          "evidence_add",
          "--project",
          fixtureRoot,
          "--source",
          "https://example.com/recent-ref",
          "--title",
          "Recent ref evidence",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const verifyResult = runCli(
      [
        "evidence_verify",
        "--project",
        fixtureRoot,
        "--evidence",
        "@last-evidence",
        "--notes",
        "verified through token",
        "--format",
        "json"
      ],
      fixtureRoot
    );
    expect(verifyResult.code).toBe(0);
    expect(verifyResult.stdout).toContain("verified through token");

    expect(
      runCli(
        [
          "branch_create",
          "--project",
          fixtureRoot,
          "--name",
          "alt-branch",
          "--reason",
          "recent ref branch test",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const branchSwitch = runCli(
      [
        "branch_switch",
        "--project",
        fixtureRoot,
        "--name",
        "@last-branch",
        "--format",
        "json"
      ],
      fixtureRoot
    );
    expect(branchSwitch.code).toBe(0);

    const statusPayload = JSON.parse(
      runCli(["status", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: { branch: { name: string } } };
    expect(statusPayload.data.branch.name).toBe("alt-branch");
  });

  it("returns evidence-aware graph payloads and stronger status summaries", () => {
    const fixtureRoot = createProjectFixture();

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Graph evidence",
          "--question",
          "Does graph_show expose evidence links?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "question",
          "--title",
          "Graph evidence node",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "evidence_add",
          "--project",
          fixtureRoot,
          "--source",
          "https://example.com/graph-evidence",
          "--title",
          "Graph evidence title",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "evidence_verify",
          "--project",
          fixtureRoot,
          "--evidence",
          "@last-evidence",
          "--notes",
          "verified in status summary test",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "evidence_link",
          "--project",
          fixtureRoot,
          "--node",
          "@last-node",
          "--evidence",
          "@last-evidence",
          "--relation",
          "supports",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_resolve",
          "--project",
          fixtureRoot,
          "--node",
          "@last-node",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "artifact_add",
          "--project",
          fixtureRoot,
          "--kind",
          "summary",
          "--title",
          "Status summary artifact",
          "--body",
          "Artifact body for status summary coverage.",
          "--node-id",
          "@last-node",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const graphPayload = JSON.parse(
      runCli(["graph_show", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as {
      data: {
        evidenceByNode: Record<string, Array<{ title: string }>>;
        evidenceIndex: Record<string, { title: string }>;
        evidenceLinks: Array<{ nodeId: string; relation: string }>;
        nodes: Array<{ id: string }>;
      };
    };
    const nodeId = graphPayload.data.nodes[0]?.id;
    expect(graphPayload.data.evidenceLinks).toHaveLength(1);
    expect(nodeId).toBeTruthy();
    const linkedEvidence = nodeId ? graphPayload.data.evidenceByNode[String(nodeId)] : undefined;
    expect(linkedEvidence?.[0]?.title).toBe("Graph evidence title");
    expect(Object.values(graphPayload.data.evidenceIndex)[0]?.title).toBe("Graph evidence title");

    const statusPayload = JSON.parse(
      runCli(["status", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as {
      context: {
        artifacts: number;
        branchName: string;
        evidence: number;
        lifecycle: string;
        nodes: number;
        resolvedNodes: number;
        verifiedEvidence: number;
      };
      summary: string;
    };
    expect(statusPayload.summary).toContain("lifecycle");
    expect(statusPayload.context.branchName).toBe("main");
    expect(statusPayload.context.evidence).toBe(1);
    expect(statusPayload.context.artifacts).toBe(1);
    expect(statusPayload.context.lifecycle).toBe("draft");
    expect(statusPayload.context.resolvedNodes).toBe(1);
    expect(statusPayload.context.verifiedEvidence).toBe(1);
  });

  it("uses graph_check semantic summaries and writes HTML artifacts for graph_visualize", () => {
    const fixtureRoot = createProjectFixture();
    const htmlPath = path.join(fixtureRoot, "artifact-view.html");

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Graph visualize artifact",
          "--question",
          "Can graph_visualize write HTML artifact output?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "question",
          "--title",
          "Visualizer evidence node",
          "--body",
          "Body for visualizer evidence node",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "evidence_add",
          "--project",
          fixtureRoot,
          "--source",
          "https://example.com/visualizer-evidence",
          "--title",
          "Visualizer evidence title",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "evidence_link",
          "--project",
          fixtureRoot,
          "--node",
          "@last-node",
          "--evidence",
          "@last-evidence",
          "--relation",
          "supports",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const graphCheckPayload = JSON.parse(
      runCli(["graph_check", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as {
      context: { edges: number; evidenceLinks: number; nodes: number; ok: boolean };
      summary: string;
    };
    expect(graphCheckPayload.summary).toContain("graph_check confirmed ok=true");
    expect(graphCheckPayload.context.evidenceLinks).toBe(1);

    const visualizeResult = runCli(
      [
        "graph_visualize",
        "--project",
        fixtureRoot,
        "--output",
        htmlPath,
        "--output-mode",
        "artifact"
      ],
      fixtureRoot
    );
    expect(visualizeResult.code).toBe(0);
    expect(visualizeResult.stdout).toBe("");

    const html = fs.readFileSync(htmlPath, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Visualizer evidence title");
    expect(html).toContain("Evidence Links:");
    expect(html).not.toContain("Command: graph_visualize");
  });

  it("bootstraps an empty --project directory without requiring local db/migrations", () => {
    const fixtureRoot = createProjectFixture();
    const migrateResult = runCli(["db_migrate", "--project", fixtureRoot, "--format", "json"], fixtureRoot);
    const listResult = runCli(["research_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot);

    expect(migrateResult.code).toBe(0);
    expect(listResult.code).toBe(0);

    const migratePayload = JSON.parse(migrateResult.stdout) as {
      command: string;
      data: { dbPath: string; executed: string[] };
      ok: boolean;
    };
    const listPayload = JSON.parse(listResult.stdout) as {
      command: string;
      context: { count: number; resultType: string };
      ok: boolean;
    };

    expect(migratePayload.ok).toBe(true);
    expect(migratePayload.command).toBe("db_migrate");
    expect(migratePayload.data.executed.length).toBeGreaterThan(0);
    expect(listPayload.ok).toBe(true);
    expect(listPayload.command).toBe("research_list");
    expect(listPayload.context.count).toBe(0);
  });

  it("finds a research by evidence-only keywords", () => {
    const fixtureRoot = createProjectFixture();

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Evidence search CLI",
          "--question",
          "Can research_search recall evidence-only terms?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    expect(
      runCli(
        [
          "evidence_add",
          "--project",
          fixtureRoot,
          "--source",
          "https://example.com/evidence/otter_source_signal",
          "--title",
          "Evidence search source heron_title_signal",
          "--summary",
          "quokka_signal only appears in evidence summary",
          "--trust-level",
          "4",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const evidenceListResult = runCli(
      ["evidence_list", "--project", fixtureRoot, "--format", "json"],
      fixtureRoot
    );

    expect(evidenceListResult.code).toBe(0);

    const evidenceListPayload = JSON.parse(evidenceListResult.stdout) as {
      data: Array<{ id: string }>;
    };
    const evidenceId = evidenceListPayload.data[0]?.id;

    expect(evidenceId).toBeTruthy();

    expect(
      runCli(
        [
          "evidence_verify",
          "--project",
          fixtureRoot,
          "--evidence",
          String(evidenceId),
          "--notes",
          "ibis_note_signal only appears in verification notes",
          "--trust-level",
          "5",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const summarySearchResult = runCli(
      ["research_search", "quokka_signal", "--project", fixtureRoot, "--format", "json"],
      fixtureRoot
    );
    const titleSearchResult = runCli(
      ["research_search", "heron_title_signal", "--project", fixtureRoot, "--format", "json"],
      fixtureRoot
    );
    const sourceSearchResult = runCli(
      ["research_search", "otter_source_signal", "--project", fixtureRoot, "--format", "json"],
      fixtureRoot
    );
    const notesSearchResult = runCli(
      ["research_search", "ibis_note_signal", "--project", fixtureRoot, "--format", "json"],
      fixtureRoot
    );

    expect(summarySearchResult.code).toBe(0);
    expect(titleSearchResult.code).toBe(0);
    expect(sourceSearchResult.code).toBe(0);
    expect(notesSearchResult.code).toBe(0);

    const searchPayloads = [summarySearchResult, titleSearchResult, sourceSearchResult, notesSearchResult].map(
      (result) =>
        JSON.parse(result.stdout) as {
          command: string;
          context: { count: number };
          ok: boolean;
          summary: string;
        }
    );

    for (const searchPayload of searchPayloads) {
      expect(searchPayload.ok).toBe(true);
      expect(searchPayload.command).toBe("research_search");
      expect(searchPayload.context.count).toBe(1);
      expect(searchPayload.summary).toBe("research_search returned 1 item(s).");
    }

    const searchPayload = searchPayloads[0] as {
      command: string;
      context: { count: number };
      ok: boolean;
      summary: string;
    };

    expect(searchPayload.context.count).toBe(1);
  });

  it("returns snake_case command metadata for canonical error responses", () => {
    const fixtureRoot = createProjectFixture();
    const result = runCli(
      ["evidence_show", "--project", fixtureRoot, "--evidence", "evidence_missing", "--format", "json"],
      fixtureRoot
    );

    expect(result.code).toBe(2);

    const payload = JSON.parse(result.stderr) as {
      command: string;
      error: string;
      ok: boolean;
      summary: string;
    };

    expect(payload.ok).toBe(false);
    expect(payload.command).toBe("evidence_show");
    expect(payload.summary).toContain("evidence_show failed");
    expect(payload.error).toContain("was not found");
  });

  it("rejects cycle-causing graph_link commands without advancing version history", () => {
    const fixtureRoot = createProjectFixture();

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "DAG cycle CLI",
          "--question",
          "Does a rejected cycle avoid transactional tails?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "question",
          "--title",
          "A",
          "--body",
          "node A",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "hypothesis",
          "--title",
          "B",
          "--body",
          "node B",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const nodeListPayload = JSON.parse(
      runCli(["node_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: Array<{ id: string; title: string }> };
    const nodeA = nodeListPayload.data.find((node) => node.title === "A");
    const nodeB = nodeListPayload.data.find((node) => node.title === "B");

    expect(nodeA?.id).toBeTruthy();
    expect(nodeB?.id).toBeTruthy();

    expect(
      runCli(
        [
          "graph_link",
          "--project",
          fixtureRoot,
          "--from",
          String(nodeA?.id),
          "--to",
          String(nodeB?.id),
          "--kind",
          "supports",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const beforeStatus = JSON.parse(
      runCli(["status", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: { branch: { headVersionId: string } } };
    const beforeVersions = JSON.parse(
      runCli(["version_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: Array<unknown> };

    const failedLink = runCli(
      [
        "graph_link",
        "--project",
        fixtureRoot,
        "--from",
        String(nodeB?.id),
        "--to",
        String(nodeA?.id),
        "--kind",
        "supports",
        "--format",
        "json"
      ],
      fixtureRoot
    );

    expect(failedLink.code).toBe(2);
    const errorPayload = JSON.parse(failedLink.stderr) as {
      command: string;
      details: { code: string; committed: boolean; fromNodeId: string; toNodeId: string };
      error: string;
      ok: boolean;
    };
    expect(errorPayload.ok).toBe(false);
    expect(errorPayload.command).toBe("graph_link");
    expect(errorPayload.details.code).toBe("DAG_CYCLE");
    expect(errorPayload.details.committed).toBe(false);
    expect(errorPayload.error).toContain("Rejected before commit");

    const afterStatus = JSON.parse(
      runCli(["status", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: { branch: { headVersionId: string } } };
    const afterVersions = JSON.parse(
      runCli(["version_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: Array<unknown> };
    const graphPayload = JSON.parse(
      runCli(["graph_show", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: { edges: Array<unknown> } };

    expect(afterStatus.data.branch.headVersionId).toBe(beforeStatus.data.branch.headVersionId);
    expect(afterVersions.data).toHaveLength(beforeVersions.data.length);
    expect(graphPayload.data.edges).toHaveLength(1);
  });

  it("rejects missing-node moves without creating a phantom version", () => {
    const fixtureRoot = createProjectFixture();

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Node move CLI",
          "--question",
          "Does a missing node move avoid transactional tails?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const beforeStatus = JSON.parse(
      runCli(["status", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: { branch: { headVersionId: string } } };
    const beforeVersions = JSON.parse(
      runCli(["version_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: Array<unknown> };

    const failedMove = runCli(
      [
        "node_move",
        "--project",
        fixtureRoot,
        "--node",
        "node_missing",
        "--format",
        "json"
      ],
      fixtureRoot
    );

    expect(failedMove.code).toBe(2);
    const errorPayload = JSON.parse(failedMove.stderr) as {
      command: string;
      details: { code: string; committed: boolean; nodeId: string };
      error: string;
      ok: boolean;
    };
    expect(errorPayload.ok).toBe(false);
    expect(errorPayload.command).toBe("node_move");
    expect(errorPayload.details.code).toBe("NODE_NOT_FOUND");
    expect(errorPayload.details.committed).toBe(false);
    expect(errorPayload.details.nodeId).toBe("node_missing");

    const afterStatus = JSON.parse(
      runCli(["status", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: { branch: { headVersionId: string } } };
    const afterVersions = JSON.parse(
      runCli(["version_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: Array<unknown> };

    expect(afterStatus.data.branch.headVersionId).toBe(beforeStatus.data.branch.headVersionId);
    expect(afterVersions.data).toHaveLength(beforeVersions.data.length);
  });

  it("generates a browser-openable SPA HTML DAG visualizer", () => {
    const fixtureRoot = createProjectFixture();
    const htmlPath = path.join(fixtureRoot, "dag-view.html");

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Visualizer test",
          "--question",
          "Can the CLI generate a SPA DAG viewer?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "question",
          "--title",
          "Root DAG question",
          "--body",
          "Graph visualizer root",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "hypothesis",
          "--title",
          "SPA view is useful",
          "--body",
          "A browser DAG helps humans inspect structure faster.",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const listPayload = JSON.parse(
      runCli(["node_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as {
      data: Array<{ id: string; title: string }>;
    };
    const root = listPayload.data.find((node) => node.title === "Root DAG question");
    const hypothesis = listPayload.data.find((node) => node.title === "SPA view is useful");

    expect(root?.id).toBeTruthy();
    expect(hypothesis?.id).toBeTruthy();
    expect(
      runCli(
        [
          "graph_link",
          "--project",
          fixtureRoot,
          "--from",
          String(root?.id),
          "--to",
          String(hypothesis?.id),
          "--kind",
          "supports",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const visualizeResult = runCli(
      [
        "graph_visualize",
        "--project",
        fixtureRoot,
        "--html-path",
        htmlPath,
        "--format",
        "json"
      ],
      fixtureRoot
    );

    expect(visualizeResult.code).toBe(0);
    const visualizePayload = JSON.parse(visualizeResult.stdout) as {
      command: string;
      data: { htmlPath: string; nodeCount: number; edgeCount: number; openedInBrowser: boolean };
      ok: boolean;
    };

    expect(visualizePayload.ok).toBe(true);
    expect(visualizePayload.command).toBe("graph_visualize");
    expect(visualizePayload.data.htmlPath).toBe(htmlPath);
    expect(visualizePayload.data.nodeCount).toBe(2);
    expect(visualizePayload.data.edgeCount).toBe(1);
    expect(visualizePayload.data.openedInBrowser).toBe(false);

    const html = fs.readFileSync(htmlPath, "utf8");
    expect(html).toContain("DAG Visualizer");
    expect(html).toContain("Root DAG question");
    expect(html).toContain("SPA view is useful");
    expect(html).toContain("Interactive branch view");
    expect(html).toContain("wrapTextToLines");
    expect(html).toContain("formatDetail");
    expect(html).toContain("detail-copy");
    expect(html).not.toContain("translateY(-4px)");
  });

  it("handles empty and very long node content in the visualizer payload", () => {
    const fixtureRoot = createProjectFixture();
    const htmlPath = path.join(fixtureRoot, "dag-edge-cases.html");
    const longTitle = "T".repeat(500);
    const longBody = "B".repeat(500);

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Visualizer edge cases",
          "--question",
          "Does the viewer tolerate empty and very long content?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "question",
          "--title",
          "Empty body node",
          "--body",
          "",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    expect(
      runCli(
        [
          "node_add",
          "--project",
          fixtureRoot,
          "--kind",
          "hypothesis",
          "--title",
          longTitle,
          "--body",
          longBody,
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const visualizeResult = runCli(
      [
        "graph_visualize",
        "--project",
        fixtureRoot,
        "--html-path",
        htmlPath,
        "--format",
        "json"
      ],
      fixtureRoot
    );

    expect(visualizeResult.code).toBe(0);

    const html = fs.readFileSync(htmlPath, "utf8");
    expect(html).toContain("Empty body node");
    expect(html).toContain(longTitle);
    expect(html).toContain(longBody);
    expect(html).toContain("No body text.");
  });
});