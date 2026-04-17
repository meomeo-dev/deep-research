import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeCrawl4aiPackage } from "../support/fake-crawl4ai-package";

const tempRoots: string[] = [];
const testServers: http.Server[] = [];
const unixSocketPaths: string[] = [];
const unixOnlyIt = process.platform === "win32" ? it.skip : it;
const packageSkillbookPath = path.join(process.cwd(), "SKILL.md");
const packageSkillbookContent = fs.readFileSync(packageSkillbookPath, "utf8");
const CLI_INTEGRATION_TIMEOUT = 15000;
const CLI_SIDECAR_TIMEOUT = 20000;

const resolvePythonForManagedSidecarTest = (): string => {
  const candidates = [
    process.env.DEEP_RESEARCH_CRAWL4AI_PYTHON,
    process.env.PYTHON,
    "/opt/homebrew/bin/python3.13",
    "/opt/homebrew/bin/python3.12",
    "/opt/homebrew/bin/python3.11",
    "/opt/homebrew/bin/python3.10",
    "/usr/bin/python3",
    "python3"
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);

  for (const candidate of candidates) {
    const result = spawnSync(
      candidate,
      ["-c", "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)"],
      {
        encoding: "utf8"
      }
    );
    if ((result.status ?? 1) === 0) {
      return candidate;
    }
  }

  throw new Error("A Python 3.10+ interpreter is required to execute the real Crawl4AI sidecar integration test.");
};

const createProjectFixture = (): string => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-cli-"));
  tempRoots.push(fixtureRoot);
  return fixtureRoot;
};

const createExecutableScript = (filePath: string, content: string): string => {
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
};

const runCli = (args: string[], fixtureRoot?: string, extraEnv?: Record<string, string>) => {
  const result = spawnSync(
    process.execPath,
    [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/cli/main.ts", ...args],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        ...(fixtureRoot ? { DEEP_RESEARCH_TEST_PROJECT: fixtureRoot } : {}),
        ...extraEnv
      }
    }
  );

  return {
    code: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout
  };
};

const runCliAsync = async (
  args: string[],
  fixtureRoot?: string,
  extraEnv?: Record<string, string>
) =>
  await new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs"), "src/cli/main.ts", ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          ...(fixtureRoot ? { DEEP_RESEARCH_TEST_PROJECT: fixtureRoot } : {}),
          ...extraEnv
        }
      }
    );
    let stderr = "";
    let stdout = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stderr,
        stdout
      });
    });
  });

const startJsonServer = async (
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void
): Promise<string> => {
  const server = http.createServer(handler);
  testServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const startUnixSocketJsonServer = async (input: {
  handler: (request: http.IncomingMessage, response: http.ServerResponse) => void;
  socketPath: string;
}): Promise<void> => {
  if (fs.existsSync(input.socketPath)) {
    fs.rmSync(input.socketPath, { force: true });
  }
  unixSocketPaths.push(input.socketPath);
  const server = http.createServer(input.handler);
  testServers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(input.socketPath, () => resolve());
  });
};

afterEach(() => {
  while (testServers.length > 0) {
    const server = testServers.pop();
    server?.close();
  }
  while (unixSocketPaths.length > 0) {
    const socketPath = unixSocketPaths.pop();
    if (socketPath) {
      fs.rmSync(socketPath, { force: true });
    }
  }
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
    expect(result.stdout).toContain("skillbook");
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
    expect(result.stdout).toContain("status, run, gate_check");
    expect(result.stdout).toContain("export");
    expect(result.stdout).toContain("Branch:");
    expect(result.stdout).toContain("version_list, branch_list, branch_create");
    expect(result.stdout).toContain("branch_switch, branch_diff, branch_archive");
    expect(result.stdout).toContain("Node:");
    expect(result.stdout).toContain("node_list, node_add, node_update");
    expect(result.stdout).toContain("Evidence:");
    expect(result.stdout).toContain("evidence_list, evidence_add, evidence_archive");
    expect(result.stdout).toContain("evidence_show, evidence_link, evidence_verify");
    expect(result.stdout).toContain("Graph:");
    expect(result.stdout).toContain("graph_show, graph_check, graph_snapshot");
    expect(result.stdout).toContain("Artifact:");
    expect(result.stdout).toContain("artifact_list, artifact_add, artifact_export");
    expect(result.stdout).toContain("Docs:");
    expect(result.stdout).toContain("skillbook");
    expect(result.stdout).toContain(
      'skillbook [options]                     Print the packaged SKILL.md handbook or JSON metadata; prefer "--format json" to include "referencesRootPath".'
    );
    expect(result.stdout).toContain("Health:");
    expect(result.stdout).toContain("db_status, db_migrate, db_doctor");
    expect(result.stdout).toContain("doctor, sidecar_setup");
  });

  it("returns raw packaged skillbook content without creating project state", () => {
    const fixtureRoot = createProjectFixture();
    const outputPath = path.join(fixtureRoot, "skillbook-copy.md");

    fs.writeFileSync(path.join(fixtureRoot, "SKILL.md"), "project-local skillbook", "utf8");

    const stdoutResult = runCli(["skillbook", "--project", fixtureRoot]);
    const outputResult = runCli(["skillbook", "--project", fixtureRoot, "--output", outputPath]);

    expect(stdoutResult.code).toBe(0);
    expect(stdoutResult.stdout).toBe(packageSkillbookContent);
    expect(fs.existsSync(path.join(fixtureRoot, ".deep-research"))).toBe(false);

    expect(outputResult.code).toBe(0);
    expect(outputResult.stdout).toBe("");
    expect(fs.readFileSync(outputPath, "utf8")).toBe(packageSkillbookContent);
  });

  it("returns skillbook metadata in the existing json envelope", () => {
    const fixtureRoot = createProjectFixture();
    const outputPath = path.join(fixtureRoot, "skillbook.json");
    const expectedRelativeLinkBasePath = path.dirname(packageSkillbookPath);
    const expectedReferencesRootPath = path.join(
      expectedRelativeLinkBasePath,
      "resources",
      "references"
    );
    const expectedScopeDesignPath = path.join(
      expectedRelativeLinkBasePath,
      "resources",
      "references",
      "01-scope-and-design.md"
    );

    fs.writeFileSync(path.join(fixtureRoot, "SKILL.md"), "project-local skillbook", "utf8");

    const result = runCli(["skillbook", "--project", fixtureRoot, "--format", "json"]);
    const outputResult = runCli([
      "skillbook",
      "--project",
      fixtureRoot,
      "--format",
      "json",
      "--output",
      outputPath
    ]);
    const payload = JSON.parse(result.stdout) as {
      command: string;
      data: {
        characterCount: number;
        content: string;
        path: string;
        referencesRootPath: string;
        relativeLinkBasePath: string;
      };
      ok: boolean;
    };
    const outputPayload = JSON.parse(fs.readFileSync(outputPath, "utf8")) as typeof payload;

    expect(result.code).toBe(0);
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe("skillbook");
    expect(payload.data.content).toBe(packageSkillbookContent);
    expect(payload.data.path).toBe(packageSkillbookPath);
    expect(payload.data.characterCount).toBe(packageSkillbookContent.length);
    expect(payload.data.relativeLinkBasePath).toBe(expectedRelativeLinkBasePath);
    expect(payload.data.referencesRootPath).toBe(expectedReferencesRootPath);
    expect(fs.existsSync(payload.data.referencesRootPath)).toBe(true);
    expect(fs.existsSync(expectedScopeDesignPath)).toBe(true);

    expect(outputResult.code).toBe(0);
    expect(outputResult.stdout).toBe("");
    expect(outputPayload).toEqual(payload);
  });

  it("shows descriptive help for common identifiers and graph export flags", () => {
    const nodeAddHelp = runCli(["node_add", "--help"]);
    const evidenceArchiveHelp = runCli(["evidence_archive", "--help"]);
    const evidenceLinkHelp = runCli(["evidence_link", "--help"]);
    const graphLinkHelp = runCli(["graph_link", "--help"]);
    const graphExportHelp = runCli(["graph_export", "--help"]);
    const sidecarSetupHelp = runCli(["sidecar_setup", "--help"]);

    expect(nodeAddHelp.code).toBe(0);
    expect(nodeAddHelp.stdout).toContain("Research id. Defaults to the active research.");
    expect(nodeAddHelp.stdout).toContain("Branch name. Defaults to the active branch.");
    expect(nodeAddHelp.stdout).toContain("Detailed body text stored with the record.");
    expect(nodeAddHelp.stdout).toContain("Node kind: question, hypothesis, evidence");

    expect(evidenceLinkHelp.code).toBe(0);
    expect(evidenceLinkHelp.stdout).toContain("Evidence id or @last-evidence recent reference.");
    expect(evidenceLinkHelp.stdout).toContain("Relation kind: supports, refutes, or annotates.");

    expect(evidenceArchiveHelp.code).toBe(0);
    expect(evidenceArchiveHelp.stdout).toContain("Archive backend: crawl4ai or node. Defaults to crawl4ai.");
    expect(evidenceArchiveHelp.stdout).toContain(
      "Explicit TCP fallback endpoint for a Crawl4AI sidecar. Secure defaults use a local manifest plus Unix socket transport instead."
    );
    expect(evidenceArchiveHelp.stdout).toContain("Archive request timeout in milliseconds.");

    expect(sidecarSetupHelp.code).toBe(0);
    expect(sidecarSetupHelp.stdout).toContain("Inspect or explicitly prepare the managed Crawl4AI sidecar runtime");
    expect(sidecarSetupHelp.stdout).toContain("--run-setup");
    expect(sidecarSetupHelp.stdout).toContain("--run-doctor");

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
  }, CLI_INTEGRATION_TIMEOUT);

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
          "--workflow-state",
          "ready",
          "--epistemic-state",
          "supported",
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
          "Readable export hypothesis",
          "--workflow-state",
          "ready",
          "--epistemic-state",
          "supported",
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
          "--workflow-state",
          "ready",
          "--epistemic-state",
          "supported",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);
    const readableNodeList = JSON.parse(
      runCli(["node_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: Array<{ id: string; title: string }> };
    const readableQuestion = readableNodeList.data.find(
      (node) => node.title === "Readable export question"
    );
    const readableHypothesis = readableNodeList.data.find(
      (node) => node.title === "Readable export hypothesis"
    );
    const readableConclusion = readableNodeList.data.find(
      (node) => node.title === "Readable export conclusion"
    );
    expect(readableQuestion?.id).toBeTruthy();
    expect(readableHypothesis?.id).toBeTruthy();
    expect(readableConclusion?.id).toBeTruthy();
    expect(
      runCli(
        [
          "graph_link",
          "--project",
          fixtureRoot,
          "--from",
          String(readableQuestion?.id),
          "--to",
          String(readableHypothesis?.id),
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
          "graph_link",
          "--project",
          fixtureRoot,
          "--from",
          String(readableHypothesis?.id),
          "--to",
          String(readableConclusion?.id),
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
    expect(
      runCli(["run", "--project", fixtureRoot, "--mode", "synthesize", "--format", "json"], fixtureRoot)
        .code
    ).toBe(0);
    expect(
      runCli(["run", "--project", fixtureRoot, "--mode", "review", "--format", "json"], fixtureRoot)
        .code
    ).toBe(0);
    expect(
      runCli(["gate_check", "--project", fixtureRoot, "--format", "json"], fixtureRoot).code
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
  }, CLI_INTEGRATION_TIMEOUT);

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
          "--workflow-state",
          "ready",
          "--epistemic-state",
          "supported",
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
          "task",
          "--title",
          "Graph artifact child",
          "--workflow-state",
          "ready",
          "--epistemic-state",
          "supported",
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
          "evidence_add",
          "--project",
          fixtureRoot,
          "--source",
          "https://example.com/graph-artifact-export",
          "--title",
          "Graph artifact evidence",
          "--summary",
          "Evidence summary for artifact export gate coverage",
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
          "verified for artifact export gate coverage",
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
          String(child?.id),
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
      runCli(["run", "--project", fixtureRoot, "--mode", "synthesize", "--format", "json"], fixtureRoot)
        .code
    ).toBe(0);
    expect(
      runCli(["run", "--project", fixtureRoot, "--mode", "review", "--format", "json"], fixtureRoot)
        .code
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
  }, CLI_INTEGRATION_TIMEOUT);

  it("blocks plain export when execution gates fail", () => {
    const fixtureRoot = createProjectFixture();

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Blocked export",
          "--question",
          "Should export fail before execution gates pass?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const exportResult = runCli(["export", "--project", fixtureRoot], fixtureRoot);

    expect(exportResult.code).toBe(2);
    expect(exportResult.stderr).toContain("Execution gates failed for final report export");
    expect(exportResult.stderr).toContain("REPORT_EXPORT_GATES_FAILED");
  });

  it("reports managed sidecar runtime readiness through doctor and sidecar_setup without mutating the environment by default", () => {
    const fixtureRoot = createProjectFixture();
    const fakePython = createExecutableScript(
      path.join(fixtureRoot, "fake-python.sh"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  echo 'Python 3.11.9'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"-c\" ]; then",
        "  exit 1",
        "fi",
        "exit 0"
      ].join("\n")
    );
    const setupCommand = createExecutableScript(
      path.join(fixtureRoot, "crawl4ai-setup"),
      ["#!/bin/sh", "echo setup-stub-ready", "exit 0"].join("\n")
    );
    const doctorCommand = createExecutableScript(
      path.join(fixtureRoot, "crawl4ai-doctor"),
      ["#!/bin/sh", "echo doctor-stub-ready", "exit 0"].join("\n")
    );
    const extraEnv = {
      DEEP_RESEARCH_CRAWL4AI_DOCTOR_COMMAND: doctorCommand,
      DEEP_RESEARCH_CRAWL4AI_PYTHON: fakePython,
      DEEP_RESEARCH_CRAWL4AI_SETUP_COMMAND: setupCommand
    };

    expect(
      runCli(
        ["init", "--project", fixtureRoot, "--title", "Sidecar inspect", "--question", "Is setup explicit?", "--format", "json"],
        fixtureRoot,
        extraEnv
      ).code
    ).toBe(0);

    const setupResult = runCli(["sidecar_setup", "--project", fixtureRoot, "--format", "json"], fixtureRoot, extraEnv);
    const doctorResult = runCli(["doctor", "--project", fixtureRoot, "--format", "json"], fixtureRoot, extraEnv);

    expect(setupResult.code).toBe(0);
    expect(doctorResult.code).toBe(0);

    const setupPayload = JSON.parse(setupResult.stdout) as {
      data: { repairCommands: string[]; status: string; summary: string };
      summary: string;
    };
    const doctorPayload = JSON.parse(doctorResult.stdout) as {
      data: { sidecarRuntime: { repairHint: string | null; status: string } };
      summary: string;
    };

    expect(setupPayload.data.status).toBe("needs_setup");
    expect(setupPayload.data.repairCommands[0]).toContain("sidecar_setup --project");
    expect(setupPayload.data.repairCommands[1]).toContain("--run-setup");
    expect(doctorPayload.data.sidecarRuntime.status).toBe("needs_setup");
    expect(doctorPayload.data.sidecarRuntime.repairHint).toContain("explicit sidecar setup");
  });

  it("runs the explicit sidecar setup command only when requested", () => {
    const fixtureRoot = createProjectFixture();
    const markerPath = path.join(fixtureRoot, "setup-ran.marker");
    const fakePython = createExecutableScript(
      path.join(fixtureRoot, "fake-python.sh"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  echo 'Python 3.11.9'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"-c\" ]; then",
        "  exit 1",
        "fi",
        "exit 0"
      ].join("\n")
    );
    const setupCommand = createExecutableScript(
      path.join(fixtureRoot, "crawl4ai-setup"),
      ["#!/bin/sh", `echo setup-ran > "${markerPath}"`, "echo setup-stub-complete", "exit 0"].join("\n")
    );
    const extraEnv = {
      DEEP_RESEARCH_CRAWL4AI_PYTHON: fakePython,
      DEEP_RESEARCH_CRAWL4AI_SETUP_COMMAND: setupCommand
    };

    expect(
      runCli(
        ["init", "--project", fixtureRoot, "--title", "Sidecar setup", "--question", "Can setup run explicitly?", "--format", "json"],
        fixtureRoot,
        extraEnv
      ).code
    ).toBe(0);

    const result = runCli(["sidecar_setup", "--project", fixtureRoot, "--run-setup", "--format", "json"], fixtureRoot, extraEnv);

    expect(result.code).toBe(0);
    expect(fs.existsSync(markerPath)).toBe(true);

    const payload = JSON.parse(result.stdout) as {
      data: { action: string; command: string; exitCode: number; stdout: string };
      summary: string;
    };

    expect(payload.data.action).toBe("setup");
    expect(payload.data.exitCode).toBe(0);
    expect(payload.data.command).toBe(setupCommand);
    expect(payload.data.stdout).toContain("setup-stub-complete");
  }, 15000);

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
  }, 15000);

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
  }, CLI_INTEGRATION_TIMEOUT);

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
  }, CLI_INTEGRATION_TIMEOUT);

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
  }, CLI_INTEGRATION_TIMEOUT);

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
  }, CLI_INTEGRATION_TIMEOUT);

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
  }, CLI_INTEGRATION_TIMEOUT);

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
  }, CLI_INTEGRATION_TIMEOUT);

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

  unixOnlyIt("uses the secure manifest and unix socket transport by default for crawl4ai", async () => {
    const fixtureRoot = createProjectFixture();
    const archiveBody = "UDS_ARCHIVE_BODY_SIGNAL";
    const token = "sidecar-secret-token";
    const socketPath = path.join(fixtureRoot, "crawl4ai.sock");
    const tokenPath = path.join(fixtureRoot, "crawl4ai.token");
    const manifestPath = path.join(fixtureRoot, ".deep-research", "crawl4ai-sidecar.json");

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Archive unix socket CLI",
          "--question",
          "Can the secure manifest transport archive without exposing a TCP endpoint?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    fs.writeFileSync(tokenPath, token, "utf8");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        socketPath,
        tokenFile: tokenPath
      }),
      "utf8"
    );
    await startUnixSocketJsonServer({
      handler: (request, response) => {
        expect(request.headers.authorization).toBe(`Bearer ${token}`);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            ok: true,
            sourceUri: "https://example.com/uds-canonical",
            title: "UDS archived evidence",
            summary: "UDS summary",
            body: `Archived body ${archiveBody}`
          })
        );
      },
      socketPath
    });

    const result = await runCliAsync(
      [
        "evidence_archive",
        "--project",
        fixtureRoot,
        "--source",
        "https://example.com/uds-source",
        "--format",
        "plain"
      ],
      fixtureRoot
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Command: evidence_archive");
    expect(result.stdout).not.toContain(archiveBody);

    const evidenceList = JSON.parse(
      runCli(["evidence_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as {
      data: Array<{ archiveStatus: string; failureReason: string | null; id: string; sourceUri: string }>;
    };

    expect(evidenceList.data[0]?.archiveStatus).toBe("archived");
    expect(evidenceList.data[0]?.failureReason).toBeNull();
    expect(evidenceList.data[0]?.sourceUri).toBe("https://example.com/uds-canonical");
  });

  unixOnlyIt("auto-starts and cleans up a managed crawl4ai sidecar by default", async () => {
    const fixtureRoot = createProjectFixture();
    const archiveBody = "MANAGED_ARCHIVE_BODY_SIGNAL";
    const manifestPath = path.join(fixtureRoot, ".deep-research", "crawl4ai-sidecar.json");
    const realPythonExecutable = resolvePythonForManagedSidecarTest();
    const setupCommand = createExecutableScript(path.join(fixtureRoot, "crawl4ai-setup"), "#!/bin/sh\nexit 0\n");
    const doctorCommand = createExecutableScript(path.join(fixtureRoot, "crawl4ai-doctor"), "#!/bin/sh\nexit 0\n");
    const pythonExecutable = createExecutableScript(
      path.join(fixtureRoot, "managed-python.sh"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        `  exec "${realPythonExecutable}" --version`,
        "fi",
        "if [ \"$1\" = \"-c\" ] && [ \"$2\" = \"import crawl4ai\" ]; then",
        "  exit 0",
        "fi",
        `exec "${realPythonExecutable}" "$@"`
      ].join("\n")
    );
    const serviceScript = path.join(process.cwd(), "tests", "fixtures", "crawl4ai_stub_service.py");
    const extraEnv = {
      DEEP_RESEARCH_CRAWL4AI_DOCTOR_COMMAND: doctorCommand,
      DEEP_RESEARCH_CRAWL4AI_PYTHON: pythonExecutable,
      DEEP_RESEARCH_CRAWL4AI_SERVICE_SCRIPT: serviceScript,
      DEEP_RESEARCH_CRAWL4AI_SETUP_COMMAND: setupCommand,
      DEEP_RESEARCH_TEST_ARCHIVE_BODY: archiveBody,
      DEEP_RESEARCH_TEST_ARCHIVE_SOURCE: "https://example.com/managed-canonical",
      DEEP_RESEARCH_TEST_ARCHIVE_SUMMARY: "Managed archive summary",
      DEEP_RESEARCH_TEST_ARCHIVE_TITLE: "Managed archived evidence"
    };

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Managed archive CLI",
          "--question",
          "Can the CLI auto-start and clean up a managed sidecar?",
          "--format",
          "json"
        ],
        fixtureRoot,
        extraEnv
      ).code
    ).toBe(0);

    const result = await runCliAsync(
      [
        "evidence_archive",
        "--project",
        fixtureRoot,
        "--source",
        "https://example.com/managed-source",
        "--format",
        "plain"
      ],
      fixtureRoot,
      extraEnv
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Command: evidence_archive");
    expect(result.stdout).not.toContain(archiveBody);
    expect(fs.existsSync(manifestPath)).toBe(false);

    const evidenceList = JSON.parse(
      runCli(["evidence_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as {
      data: Array<{ archiveStatus: string; failureReason: string | null; id: string; sourceUri: string }>;
    };

    expect(evidenceList.data[0]?.archiveStatus).toBe("archived");
    expect(evidenceList.data[0]?.failureReason).toBeNull();
    expect(evidenceList.data[0]?.sourceUri).toBe("https://example.com/managed-canonical");
  }, CLI_SIDECAR_TIMEOUT);

  unixOnlyIt("preserves anti-bot failureReason prefixes from a managed crawl4ai sidecar", async () => {
    const fixtureRoot = createProjectFixture();
    const manifestPath = path.join(fixtureRoot, ".deep-research", "crawl4ai-sidecar.json");
    const realPythonExecutable = resolvePythonForManagedSidecarTest();
    const setupCommand = createExecutableScript(path.join(fixtureRoot, "crawl4ai-setup"), "#!/bin/sh\nexit 0\n");
    const doctorCommand = createExecutableScript(path.join(fixtureRoot, "crawl4ai-doctor"), "#!/bin/sh\nexit 0\n");
    const pythonExecutable = createExecutableScript(
      path.join(fixtureRoot, "managed-python.sh"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        `  exec "${realPythonExecutable}" --version`,
        "fi",
        'if [ "$1" = "-c" ] && [ "$2" = "import crawl4ai" ]; then',
        "  exit 0",
        "fi",
        `exec "${realPythonExecutable}" "$@"`
      ].join("\n")
    );
    const serviceScript = path.join(process.cwd(), "tests", "fixtures", "crawl4ai_stub_service.py");
    const antiBotFailure =
      "CRAWL4AI_ANTIBOT_CHALLENGE: Access Denied by bot defense | probe: status=403 ; x-tengine-error=denied by bot";
    const extraEnv = {
      DEEP_RESEARCH_CRAWL4AI_DOCTOR_COMMAND: doctorCommand,
      DEEP_RESEARCH_CRAWL4AI_PYTHON: pythonExecutable,
      DEEP_RESEARCH_CRAWL4AI_SERVICE_SCRIPT: serviceScript,
      DEEP_RESEARCH_CRAWL4AI_SETUP_COMMAND: setupCommand,
      DEEP_RESEARCH_TEST_ARCHIVE_FAILURE_REASON: antiBotFailure,
      DEEP_RESEARCH_TEST_ARCHIVE_FAILURE_STATUS: "502",
      DEEP_RESEARCH_TEST_ARCHIVE_SOURCE: "https://example.com/managed-antibot"
    };

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Managed anti-bot archive CLI",
          "--question",
          "Will managed sidecar anti-bot failureReason prefixes survive CLI degraded output?",
          "--format",
          "json"
        ],
        fixtureRoot,
        extraEnv
      ).code
    ).toBe(0);

    const result = await runCliAsync(
      [
        "evidence_archive",
        "--project",
        fixtureRoot,
        "--source",
        "https://example.com/protected.pdf",
        "--format",
        "json"
      ],
      fixtureRoot,
      extraEnv
    );

    if (result.code !== 0) {
      throw new Error(`CLI failed\nSTDERR:\n${result.stderr}\nSTDOUT:\n${result.stdout}`);
    }
    expect(fs.existsSync(manifestPath)).toBe(false);

    const payload = JSON.parse(result.stdout) as {
      data: {
        archive: { failureReason: string | null; status: string };
        evidence: { archiveStatus: string; failureReason: string | null };
      };
      summary: string;
    };

    expect(payload.summary).toContain("archive degraded");
    expect(payload.data.archive.status).toBe("degraded");
    expect(payload.data.archive.failureReason).toBe(antiBotFailure);
    expect(payload.data.evidence.archiveStatus).toBe("degraded");
    expect(payload.data.evidence.failureReason).toBe(antiBotFailure);
  }, CLI_SIDECAR_TIMEOUT);

  unixOnlyIt("probes anti-bot evidence before final failure classification in the real managed sidecar", async () => {
    const fixtureRoot = createProjectFixture();
    const manifestPath = path.join(fixtureRoot, ".deep-research", "crawl4ai-sidecar.json");
    const realPythonExecutable = resolvePythonForManagedSidecarTest();
    const setupCommand = createExecutableScript(path.join(fixtureRoot, "crawl4ai-setup"), "#!/bin/sh\nexit 0\n");
    const doctorCommand = createExecutableScript(path.join(fixtureRoot, "crawl4ai-doctor"), "#!/bin/sh\nexit 0\n");
    const fakePackageRoot = createFakeCrawl4aiPackage(fixtureRoot, {
      errorMessage: "Access Denied by bot defense"
    });
    const serviceScript = path.join(process.cwd(), "resources", "sidecar", "crawl4ai_service.py");
    const protectedOrigin = await startJsonServer((_request, response) => {
      response.writeHead(403, {
        "content-type": "text/html",
        "x-tengine-error": "denied by bot"
      });
      response.end("Access denied");
    });
    const sourceUrl = `${protectedOrigin}/protected`;
    const expectedFailureReason =
      "CRAWL4AI_ANTIBOT_CHALLENGE: Access Denied by bot defense | probe: status=403 ; content-type=text/html ; x-tengine-error=denied by bot";
    const pythonPath = [fakePackageRoot, process.env.PYTHONPATH]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join(path.delimiter);
    const extraEnv = {
      DEEP_RESEARCH_CRAWL4AI_DOCTOR_COMMAND: doctorCommand,
      DEEP_RESEARCH_CRAWL4AI_PYTHON: realPythonExecutable,
      DEEP_RESEARCH_CRAWL4AI_SERVICE_SCRIPT: serviceScript,
      DEEP_RESEARCH_CRAWL4AI_SETUP_COMMAND: setupCommand,
      PYTHONPATH: pythonPath
    };

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Managed sidecar causal chain CLI",
          "--question",
          "Will the real sidecar probe antibot evidence before final classification?",
          "--format",
          "json"
        ],
        fixtureRoot,
        extraEnv
      ).code
    ).toBe(0);

    const result = await runCliAsync(
      [
        "evidence_archive",
        "--project",
        fixtureRoot,
        "--source",
        sourceUrl,
        "--format",
        "json"
      ],
      fixtureRoot,
      extraEnv
    );

    if (result.code !== 0) {
      throw new Error(`CLI failed\nSTDERR:\n${result.stderr}\nSTDOUT:\n${result.stdout}`);
    }
    expect(fs.existsSync(manifestPath)).toBe(false);

    const payload = JSON.parse(result.stdout) as {
      data: {
        archive: { failureReason: string | null; status: string };
        evidence: { archiveStatus: string; failureReason: string | null };
      };
      summary: string;
    };

    expect(payload.summary).toContain("archive degraded");
    expect(payload.data.archive.status).toBe("degraded");
    expect(payload.data.archive.failureReason).toBe(expectedFailureReason);
    expect(payload.data.evidence.archiveStatus).toBe("degraded");
    expect(payload.data.evidence.failureReason).toBe(expectedFailureReason);
  }, 15000);

  it("uses explicit TCP fallback when a crawl4ai endpoint is provided and does not leak body text to stdout", async () => {
    const fixtureRoot = createProjectFixture();
    const archiveBody = "ADAPTER_ARCHIVE_BODY_SIGNAL";
    const backendEndpoint = await startJsonServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          sourceUri: "https://example.com/adapter-canonical",
          title: "Adapter archived evidence",
          summary: "Adapter summary",
          body: `Archived body ${archiveBody}`
        })
      );
    });

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Archive adapter CLI",
          "--question",
          "Can the adapter archive without leaking body text?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const result = await runCliAsync(
      [
        "evidence_archive",
        "--project",
        fixtureRoot,
        "--source",
        "https://example.com/adapter-source",
        "--backend-endpoint",
        backendEndpoint,
        "--format",
        "plain"
      ],
      fixtureRoot
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Command: evidence_archive");
    expect(result.stdout).toContain("Summary:");
    expect(result.stdout).not.toContain(archiveBody);

    const evidenceList = JSON.parse(
      runCli(["evidence_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as {
      data: Array<{ archiveStatus: string; failureReason: string | null; id: string; sourceUri: string }>;
    };
    const artifactList = JSON.parse(
      runCli(["artifact_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as {
      data: Array<{ artifactKind: string; evidenceId: string | null }>;
    };

    expect(evidenceList.data[0]?.archiveStatus).toBe("archived");
    expect(evidenceList.data[0]?.failureReason).toBeNull();
    expect(evidenceList.data[0]?.sourceUri).toBe("https://example.com/adapter-canonical");
    expect(artifactList.data[0]?.artifactKind).toBe("web_archive");
    expect(artifactList.data[0]?.evidenceId).toBe(evidenceList.data[0]?.id);
  });

  it("preserves sidecar failureReason when crawl4ai adapter returns HTTP 500 with JSON payload", async () => {
    const fixtureRoot = createProjectFixture();
    const backendEndpoint = await startJsonServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: false,
          failureReason: "CRAWL4AI_ARCHIVE_FAILED: pdf parser crashed"
        })
      );
    });

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Archive adapter failure reason",
          "--question",
          "Will adapter failureReason be preserved from a non-2xx JSON response?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const failingEndpoint = await runCliAsync(
      [
        "evidence_archive",
        "--project",
        fixtureRoot,
        "--source",
        "https://example.com/adapter-source",
        "--backend-endpoint",
        backendEndpoint,
        "--format",
        "json"
      ],
      fixtureRoot
    );

    expect(failingEndpoint.code).toBe(0);
    const payload = JSON.parse(failingEndpoint.stdout) as {
      data: {
        archive: { failureReason: string | null; status: string };
        evidence: { failureReason: string | null };
      };
      summary: string;
    };

    expect(payload.data.archive.status).toBe("degraded");
    expect(payload.data.archive.failureReason).toContain("CRAWL4AI_ARCHIVE_FAILED");
    expect(payload.data.evidence.failureReason).toContain("CRAWL4AI_ARCHIVE_FAILED");
  });

  it("returns degraded evidence_archive records when node fallback cannot archive content", () => {
    const fixtureRoot = createProjectFixture();

    expect(
      runCli(
        [
          "init",
          "--project",
          fixtureRoot,
          "--title",
          "Archive degrade CLI",
          "--question",
          "Can degraded archive state be persisted?",
          "--format",
          "json"
        ],
        fixtureRoot
      ).code
    ).toBe(0);

    const result = runCli(
      [
        "evidence_archive",
        "--project",
        fixtureRoot,
        "--backend",
        "node",
        "--source",
        "data:application/octet-stream;base64,AA==",
        "--format",
        "json"
      ],
      fixtureRoot
    );

    expect(result.code).toBe(0);

    const payload = JSON.parse(result.stdout) as {
      data: {
        archive: { artifactId: string | null; failureReason: string | null; status: string };
        evidence: { archiveStatus: string; failureReason: string | null };
      };
      summary: string;
    };
    const artifactList = JSON.parse(
      runCli(["artifact_list", "--project", fixtureRoot, "--format", "json"], fixtureRoot).stdout
    ) as { data: Array<unknown> };

    expect(payload.summary).toContain("archive degraded");
    expect(payload.data.archive.status).toBe("degraded");
    expect(payload.data.archive.artifactId).toBeNull();
    expect(payload.data.archive.failureReason).toContain("UNSUPPORTED_CONTENT_TYPE");
    expect(payload.data.evidence.archiveStatus).toBe("degraded");
    expect(payload.data.evidence.failureReason).toContain("UNSUPPORTED_CONTENT_TYPE");
    expect(artifactList.data).toHaveLength(0);
  });

  it("shows explicit sidecar setup repair hints when evidence_archive hits an unprepared managed crawl4ai runtime", () => {
    const fixtureRoot = createProjectFixture();
    const fakePython = createExecutableScript(
      path.join(fixtureRoot, "fake-python.sh"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  echo 'Python 3.11.9'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"-c\" ]; then",
        "  exit 1",
        "fi",
        "exit 0"
      ].join("\n")
    );
    const extraEnv = {
      DEEP_RESEARCH_CRAWL4AI_PYTHON: fakePython
    };

    expect(
      runCli(
        ["init", "--project", fixtureRoot, "--title", "Archive repair hints", "--question", "Will archive failures suggest setup?", "--format", "json"],
        fixtureRoot,
        extraEnv
      ).code
    ).toBe(0);

    const result = runCli(
      ["evidence_archive", "--project", fixtureRoot, "--source", "https://example.com/archive-source", "--format", "json"],
      fixtureRoot,
      extraEnv
    );

    expect(result.code).toBe(2);

    const payload = JSON.parse(result.stderr) as {
      details: { repairCommands: string[]; repairHint: string; status: string };
      error: string;
      summary: string;
    };

    expect(payload.error).toContain("CRAWL4AI_RUNTIME_NOT_READY");
    expect(payload.details.status).toBe("needs_setup");
    expect(payload.details.repairHint).toContain("explicit sidecar setup");
    expect(payload.details.repairCommands[1]).toContain("sidecar_setup --project");
    expect(payload.details.repairCommands[2]).toContain("--run-doctor");
  }, 15000);
});
