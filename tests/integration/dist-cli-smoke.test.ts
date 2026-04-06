import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const tempRoots: string[] = [];
const distCliEntry = path.join(process.cwd(), "dist", "cli", "main.js");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const createProjectFixture = (): string => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-dist-cli-"));
  tempRoots.push(fixtureRoot);
  return fixtureRoot;
};

const runDistCli = (args: string[]) => {
  const result = spawnSync(process.execPath, [distCliEntry, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env
  });

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

beforeAll(() => {
  const buildResult = spawnSync(packageManager, ["build"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env
  });

  expect(buildResult.status ?? 1).toBe(0);
});

describe("dist CLI release surface", () => {
  it("exposes --output-mode in root help", () => {
    expect(fs.existsSync(distCliEntry)).toBe(true);

    const result = runDistCli(["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("--output-mode <auto|envelope|artifact>");
  });

  it("persists recent evidence refs across separate dist CLI invocations", () => {
    const fixtureRoot = createProjectFixture();

    expect(
      runDistCli([
        "init",
        "--project",
        fixtureRoot,
        "--title",
        "Dist recent refs",
        "--question",
        "Does dist persist recent refs across processes?",
        "--format",
        "json"
      ]).code
    ).toBe(0);

    const evidenceAddResult = runDistCli([
      "evidence_add",
      "--project",
      fixtureRoot,
      "--source",
      "https://example.com/dist-recent-ref",
      "--title",
      "Dist recent ref evidence",
      "--summary",
      "Smoke test for dist recent refs",
      "--format",
      "json"
    ]);

    expect(evidenceAddResult.code).toBe(0);
    expect(
      fs.existsSync(path.join(fixtureRoot, ".deep-research", "recent-refs.json"))
    ).toBe(true);

    const evidenceVerifyResult = runDistCli([
      "evidence_verify",
      "--project",
      fixtureRoot,
      "--evidence",
      "@last-evidence",
      "--notes",
      "verified through dist recent ref",
      "--format",
      "json"
    ]);

    expect(evidenceVerifyResult.code).toBe(0);
    expect(evidenceVerifyResult.stdout).toContain("verifiedAt");
  });

  it("writes artifact-only export files through the dist CLI", () => {
    const fixtureRoot = createProjectFixture();
    const reportPath = path.join(fixtureRoot, "dist-readable-report.txt");

    expect(
      runDistCli([
        "init",
        "--project",
        fixtureRoot,
        "--title",
        "Dist artifact export",
        "--question",
        "Can dist export write an artifact-only file?",
        "--format",
        "json"
      ]).code
    ).toBe(0);
    expect(
      runDistCli([
        "node_add",
        "--project",
        fixtureRoot,
        "--kind",
        "question",
        "--title",
        "Dist artifact export question",
        "--format",
        "json"
      ]).code
    ).toBe(0);
    expect(
      runDistCli([
        "node_add",
        "--project",
        fixtureRoot,
        "--kind",
        "conclusion",
        "--title",
        "Dist artifact export conclusion",
        "--format",
        "json"
      ]).code
    ).toBe(0);
    expect(
      runDistCli([
        "evidence_add",
        "--project",
        fixtureRoot,
        "--source",
        "https://example.com/dist-artifact-export",
        "--title",
        "Dist artifact export evidence",
        "--summary",
        "Evidence summary for dist artifact export",
        "--format",
        "json"
      ]).code
    ).toBe(0);
    expect(
      runDistCli([
        "evidence_verify",
        "--project",
        fixtureRoot,
        "--evidence",
        "@last-evidence",
        "--notes",
        "verified through dist recent ref",
        "--format",
        "json"
      ]).code
    ).toBe(0);
    expect(
      runDistCli([
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
      ]).code
    ).toBe(0);
    expect(
      runDistCli([
        "artifact_add",
        "--project",
        fixtureRoot,
        "--kind",
        "conclusion_summary",
        "--title",
        "Dist readable conclusion artifact",
        "--body",
        "Readable final conclusion body from dist CLI.",
        "--node-id",
        "@last-node",
        "--format",
        "json"
      ]).code
    ).toBe(0);

    const exportResult = runDistCli([
      "--output",
      reportPath,
      "--output-mode",
      "artifact",
      "export",
      "--project",
      fixtureRoot
    ]);

    expect(exportResult.code).toBe(0);
    expect(exportResult.stdout).toBe("");

    const report = fs.readFileSync(reportPath, "utf8");
    expect(report).toContain("# Dist artifact export");
    expect(report).toContain("## Readable Artifacts");
    expect(report).toContain("Readable final conclusion body from dist CLI.");
    expect(report).not.toContain("Command: export");
    expect(report).not.toContain("Summary: export");
  });

  it("exports PNG graph artifacts through the dist CLI", () => {
    const fixtureRoot = createProjectFixture();
    const pngPath = path.join(fixtureRoot, "dist-graph-export.png");

    expect(
      runDistCli([
        "init",
        "--project",
        fixtureRoot,
        "--title",
        "Dist PNG export",
        "--question",
        "Can the dist CLI export a graph PNG?",
        "--format",
        "json"
      ]).code
    ).toBe(0);
    expect(
      runDistCli([
        "node_add",
        "--project",
        fixtureRoot,
        "--kind",
        "question",
        "--title",
        "Dist PNG root",
        "--format",
        "json"
      ]).code
    ).toBe(0);
    expect(
      runDistCli([
        "node_add",
        "--project",
        fixtureRoot,
        "--kind",
        "finding",
        "--title",
        "Dist PNG child",
        "--format",
        "json"
      ]).code
    ).toBe(0);

    const nodeList = JSON.parse(
      runDistCli(["node_list", "--project", fixtureRoot, "--format", "json"]).stdout
    ) as { data: Array<{ id: string; title: string }> };
    const root = nodeList.data.find((node) => node.title === "Dist PNG root");
    const child = nodeList.data.find((node) => node.title === "Dist PNG child");

    expect(root?.id).toBeTruthy();
    expect(child?.id).toBeTruthy();
    expect(
      runDistCli([
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
      ]).code
    ).toBe(0);

    const exportResult = runDistCli([
      "graph_export",
      "--project",
      fixtureRoot,
      "--export-format",
      "png",
      "--output",
      pngPath,
      "--format",
      "json"
    ]);

    expect(exportResult.code).toBe(0);
    const payload = JSON.parse(exportResult.stdout) as {
      data: { fileSize: number; pngPath: string };
      ok: boolean;
    };

    expect(payload.ok).toBe(true);
    expect(payload.data.pngPath).toBe(pngPath);
    expect(payload.data.fileSize).toBeGreaterThan(1024);
    expect(payload.data.fileSize).toBeLessThanOrEqual(10 * 1024 * 1024);

    const buffer = fs.readFileSync(pngPath);
    expect(buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
