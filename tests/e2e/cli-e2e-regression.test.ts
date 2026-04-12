import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ensureDistBuilt } from "../support/ensure-dist-built";

const tempRoots: string[] = [];
const distCliEntry = path.join(process.cwd(), "dist", "cli", "main.js");
const packageSkillbookPath = path.join(process.cwd(), "SKILL.md");
const packageSkillbookContent = fs.readFileSync(packageSkillbookPath, "utf8");

type CliResult = {
  code: number;
  stderr: string;
  stdout: string;
};

type Envelope<T> = {
  command: string;
  data: T;
  ok: boolean;
};

type NodeRecord = {
  id: string;
  title: string;
};

type EvidenceRecord = {
  id: string;
  title: string;
};

type CommandPlan = () => void;

type CommandState = {
  conclusionNodeId: string;
  evidenceId: string;
  findingNodeId: string;
  gapNodeId: string;
  hypothesisNodeId: string;
  noteNodeId: string;
  questionNodeId: string;
  researchId: string;
};

const createProjectFixture = (): string => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-cli-e2e-"));
  tempRoots.push(fixtureRoot);
  return fixtureRoot;
};

const createExecutableScript = (filePath: string, content: string): string => {
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
  return filePath;
};

const runDistCli = (args: string[], extraEnv?: Record<string, string>): CliResult => {
  const result = spawnSync(process.execPath, [distCliEntry, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv
    }
  });

  return {
    code: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout
  };
};

const parseRootCommands = (helpText: string): string[] => {
  const commandLines = helpText
    .split("\n")
    .map((line) => line.match(/^\s{2}([a-z_]+)\b/))
    .flatMap((match) => (match?.[1] ? [match[1]] : []));

  return commandLines.filter((command): command is string => command !== "help");
};

const assertSuccess = (label: string, result: CliResult): void => {
  if (result.code !== 0) {
    throw new Error(
      `${label} failed with exit code ${result.code}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
};

const runJsonCommand = <T>(
  executed: Set<string>,
  fixtureRoot: string,
  command: string,
  args: string[] = [],
  extraEnv?: Record<string, string>
): Envelope<T> => {
  executed.add(command);
  const result = runDistCli(["--project", fixtureRoot, "--format", "json", command, ...args], extraEnv);
  assertSuccess(command, result);
  return JSON.parse(result.stdout) as Envelope<T>;
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
  ensureDistBuilt();
});

describe("CLI e2e regression", () => {
  it("runs every advertised CLI subcommand successfully at least once", () => {
    const helpResult = runDistCli(["--help"]);
    assertSuccess("root help", helpResult);

    const discoveredCommands = parseRootCommands(helpResult.stdout).sort();
    const executedCommands = new Set<string>();
    const fixtureRoot = createProjectFixture();
    const htmlPath = path.join(fixtureRoot, "graph.html");
    const state: CommandState = {
      conclusionNodeId: "",
      evidenceId: "",
      findingNodeId: "",
      gapNodeId: "",
      hypothesisNodeId: "",
      noteNodeId: "",
      questionNodeId: "",
      researchId: ""
    };

    const commandPlans = {
      artifact_add: () => {
        runJsonCommand(executedCommands, fixtureRoot, "artifact_add", [
          "--kind",
          "conclusion_summary",
          "--title",
          "CLI e2e artifact",
          "--body",
          "Artifact body from the e2e regression test.",
          "--node-id",
          state.conclusionNodeId
        ]);
      },
      artifact_export: () => {
        runJsonCommand(executedCommands, fixtureRoot, "artifact_export");
      },
      artifact_list: () => {
        runJsonCommand(executedCommands, fixtureRoot, "artifact_list");
      },
      branch_archive: () => {
        runJsonCommand(executedCommands, fixtureRoot, "branch_archive", ["--name", "alt"]);
      },
      branch_create: () => {
        runJsonCommand(executedCommands, fixtureRoot, "branch_create", [
          "--name",
          "alt",
          "--reason",
          "E2E alternate branch"
        ]);
      },
      branch_diff: () => {
        runJsonCommand(executedCommands, fixtureRoot, "branch_diff", [
          "--left",
          "main",
          "--right",
          "alt"
        ]);
      },
      branch_list: () => {
        runJsonCommand(executedCommands, fixtureRoot, "branch_list");
      },
      branch_switch: () => {
        runJsonCommand(executedCommands, fixtureRoot, "branch_switch", ["--name", "alt"]);
        runJsonCommand(executedCommands, fixtureRoot, "node_add", [
          "--kind",
          "note",
          "--title",
          "Alt branch note",
          "--body",
          "Only present on the alternate branch."
        ]);
        runJsonCommand(executedCommands, fixtureRoot, "branch_switch", ["--name", "main"]);
      },
      db_doctor: () => {
        runJsonCommand(executedCommands, fixtureRoot, "db_doctor");
      },
      db_migrate: () => {
        runJsonCommand(executedCommands, fixtureRoot, "db_migrate");
      },
      db_status: () => {
        runJsonCommand(executedCommands, fixtureRoot, "db_status");
      },
      doctor: () => {
        runJsonCommand(executedCommands, fixtureRoot, "doctor");
      },
      gate_check: () => {
        runJsonCommand(executedCommands, fixtureRoot, "gate_check");
      },
      evidence_add: () => {
        const payload = runJsonCommand<EvidenceRecord>(executedCommands, fixtureRoot, "evidence_add", [
          "--source",
          "https://example.com/e2e-cli",
          "--title",
          "CLI e2e evidence",
          "--summary",
          "Evidence created by the e2e regression suite",
          "--trust-level",
          "4"
        ]);
        state.evidenceId = payload.data.id;
      },
      evidence_archive: () => {
        runJsonCommand<{ archive: { status: string } }>(executedCommands, fixtureRoot, "evidence_archive", [
          "--backend",
          "node",
          "--source",
          `data:text/html,${encodeURIComponent("<html><head><title>E2E archive</title></head><body>E2E archive body</body></html>")}`
        ]);
        runJsonCommand(executedCommands, fixtureRoot, "evidence_verify", [
          "--evidence",
          "@last-evidence",
          "--notes",
          "verified archived evidence in cli e2e regression"
        ]);
        runJsonCommand(executedCommands, fixtureRoot, "evidence_link", [
          "--node",
          state.findingNodeId,
          "--evidence",
          "@last-evidence",
          "--relation",
          "supports"
        ]);
      },
      evidence_link: () => {
        runJsonCommand(executedCommands, fixtureRoot, "evidence_link", [
          "--node",
          state.findingNodeId,
          "--evidence",
          state.evidenceId,
          "--relation",
          "supports"
        ]);
      },
      evidence_list: () => {
        runJsonCommand(executedCommands, fixtureRoot, "evidence_list");
      },
      evidence_show: () => {
        runJsonCommand(executedCommands, fixtureRoot, "evidence_show", ["--evidence", state.evidenceId]);
      },
      evidence_verify: () => {
        runJsonCommand(executedCommands, fixtureRoot, "evidence_verify", [
          "--evidence",
          state.evidenceId,
          "--notes",
          "verified in cli e2e regression"
        ]);
      },
      export: () => {
        runJsonCommand(executedCommands, fixtureRoot, "export");
      },
      graph_check: () => {
        runJsonCommand(executedCommands, fixtureRoot, "graph_check");
      },
      graph_export: () => {
        runJsonCommand(executedCommands, fixtureRoot, "graph_export");
      },
      graph_link: () => {
        runJsonCommand(executedCommands, fixtureRoot, "graph_link", [
          "--from",
          state.questionNodeId,
          "--to",
          state.hypothesisNodeId,
          "--kind",
          "supports"
        ]);
        runJsonCommand(executedCommands, fixtureRoot, "graph_link", [
          "--from",
          state.hypothesisNodeId,
          "--to",
          state.findingNodeId,
          "--kind",
          "supports"
        ]);
        runJsonCommand(executedCommands, fixtureRoot, "graph_link", [
          "--from",
          state.findingNodeId,
          "--to",
          state.conclusionNodeId,
          "--kind",
          "supports"
        ]);
      },
      graph_show: () => {
        runJsonCommand(executedCommands, fixtureRoot, "graph_show");
      },
      graph_snapshot: () => {
        runJsonCommand(executedCommands, fixtureRoot, "graph_snapshot", [
          "--reason",
          "E2E snapshot"
        ]);
      },
      graph_visualize: () => {
        runJsonCommand(executedCommands, fixtureRoot, "graph_visualize", ["--html-path", htmlPath]);
        expect(fs.existsSync(htmlPath)).toBe(true);
      },
      init: () => {
        const payload = runJsonCommand<{
          currentBranchId: string;
          id: string;
          title: string;
        }>(executedCommands, fixtureRoot, "init", [
          "--title",
          "CLI e2e regression",
          "--question",
          "Can every CLI subcommand run successfully at least once?"
        ]);
        state.researchId = payload.data.id;
      },
      node_add: () => {
        state.questionNodeId = runJsonCommand<NodeRecord>(executedCommands, fixtureRoot, "node_add", [
          "--kind",
          "question",
          "--title",
          "E2E root question",
          "--workflow-state",
          "ready",
          "--epistemic-state",
          "supported"
        ]).data.id;
        state.hypothesisNodeId = runJsonCommand<NodeRecord>(executedCommands, fixtureRoot, "node_add", [
          "--kind",
          "hypothesis",
          "--title",
          "E2E hypothesis",
          "--workflow-state",
          "ready",
          "--epistemic-state",
          "supported"
        ]).data.id;
        state.findingNodeId = runJsonCommand<NodeRecord>(executedCommands, fixtureRoot, "node_add", [
          "--kind",
          "finding",
          "--title",
          "E2E finding",
          "--workflow-state",
          "ready",
          "--epistemic-state",
          "supported"
        ]).data.id;
        state.gapNodeId = runJsonCommand<NodeRecord>(executedCommands, fixtureRoot, "node_add", [
          "--kind",
          "gap",
          "--title",
          "E2E gap",
          "--workflow-state",
          "blocked",
          "--epistemic-state",
          "inconclusive"
        ]).data.id;
        state.noteNodeId = runJsonCommand<NodeRecord>(executedCommands, fixtureRoot, "node_add", [
          "--kind",
          "note",
          "--title",
          "E2E note"
        ]).data.id;
        state.conclusionNodeId = runJsonCommand<NodeRecord>(executedCommands, fixtureRoot, "node_add", [
          "--kind",
          "conclusion",
          "--title",
          "E2E conclusion",
          "--workflow-state",
          "ready",
          "--epistemic-state",
          "supported"
        ]).data.id;
      },
      node_list: () => {
        const payload = runJsonCommand<NodeRecord[]>(executedCommands, fixtureRoot, "node_list");
        expect(payload.data.length).toBeGreaterThanOrEqual(6);
      },
      node_move: () => {
        runJsonCommand(executedCommands, fixtureRoot, "node_move", [
          "--node",
          state.noteNodeId,
          "--after",
          state.findingNodeId
        ]);
      },
      node_remove: () => {
        runJsonCommand(executedCommands, fixtureRoot, "node_remove", ["--node", state.noteNodeId]);
      },
      node_resolve: () => {
        runJsonCommand(executedCommands, fixtureRoot, "node_resolve", ["--node", state.gapNodeId]);
      },
      node_update: () => {
        runJsonCommand(executedCommands, fixtureRoot, "node_update", [
          "--node",
          state.findingNodeId,
          "--title",
          "E2E finding updated",
          "--body",
          "Updated in the e2e regression suite."
        ]);
      },
      research_list: () => {
        runJsonCommand(executedCommands, fixtureRoot, "research_list");
      },
      research_search: () => {
        runJsonCommand(executedCommands, fixtureRoot, "research_search", [
          "subcommand run successfully"
        ]);
      },
      run: () => {
        runJsonCommand(executedCommands, fixtureRoot, "run", ["--mode", "synthesize"]);
        runJsonCommand(executedCommands, fixtureRoot, "run", ["--mode", "review"]);
      },
      skillbook: () => {
        fs.writeFileSync(path.join(fixtureRoot, "SKILL.md"), "project-local e2e skillbook", "utf8");
        const expectedRelativeLinkBasePath = path.dirname(packageSkillbookPath);
        const expectedReferencesRootPath = path.join(
          expectedRelativeLinkBasePath,
          "resources",
          "references"
        );

        const payload = runJsonCommand<{
          characterCount: number;
          content: string;
          path: string;
          referencesRootPath: string;
          relativeLinkBasePath: string;
        }>(executedCommands, fixtureRoot, "skillbook");

        expect(payload.data.content).toBe(packageSkillbookContent);
        expect(payload.data.path).toBe(packageSkillbookPath);
        expect(payload.data.characterCount).toBe(packageSkillbookContent.length);
        expect(payload.data.relativeLinkBasePath).toBe(expectedRelativeLinkBasePath);
        expect(payload.data.referencesRootPath).toBe(expectedReferencesRootPath);
        expect(
          fs.existsSync(path.join(payload.data.referencesRootPath, "01-scope-and-design.md"))
        ).toBe(true);
        expect(fs.existsSync(path.join(fixtureRoot, ".deep-research"))).toBe(false);
      },
      status: () => {
        runJsonCommand(executedCommands, fixtureRoot, "status");
      },
      sidecar_setup: () => {
        const markerPath = path.join(fixtureRoot, "e2e-sidecar-setup.marker");
        const fakePython = createExecutableScript(
          path.join(fixtureRoot, "e2e-fake-python.sh"),
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
          ["#!/bin/sh", `echo setup-ran > "${markerPath}"`, "echo e2e-setup-complete", "exit 0"].join("\n")
        );
        const doctorCommand = createExecutableScript(
          path.join(fixtureRoot, "crawl4ai-doctor"),
          ["#!/bin/sh", "echo e2e-doctor-complete", "exit 0"].join("\n")
        );
        const extraEnv = {
          DEEP_RESEARCH_CRAWL4AI_DOCTOR_COMMAND: doctorCommand,
          DEEP_RESEARCH_CRAWL4AI_PYTHON: fakePython,
          DEEP_RESEARCH_CRAWL4AI_SETUP_COMMAND: setupCommand
        };

        const inspectPayload = runJsonCommand<{ status: string }>(
          executedCommands,
          fixtureRoot,
          "sidecar_setup",
          [],
          extraEnv
        );
        expect(inspectPayload.data.status).toBe("needs_setup");

        const setupPayload = runJsonCommand<{ action: string; exitCode: number }>(
          executedCommands,
          fixtureRoot,
          "sidecar_setup",
          ["--run-setup"],
          extraEnv
        );
        expect(setupPayload.data.action).toBe("setup");
        expect(setupPayload.data.exitCode).toBe(0);
        expect(fs.existsSync(markerPath)).toBe(true);

        const doctorPayload = runJsonCommand<{ action: string; exitCode: number }>(
          executedCommands,
          fixtureRoot,
          "sidecar_setup",
          ["--run-doctor"],
          extraEnv
        );
        expect(doctorPayload.data.action).toBe("doctor");
        expect(doctorPayload.data.exitCode).toBe(0);
      },
      version_list: () => {
        runJsonCommand(executedCommands, fixtureRoot, "version_list", ["--branch", "main"]);
      }
    } satisfies Record<string, CommandPlan>;

    const runPlan = (command: keyof typeof commandPlans): void => {
      commandPlans[command]();
    };

    expect(Object.keys(commandPlans).sort()).toEqual(discoveredCommands);

    runPlan("skillbook");
    runPlan("init");
    runPlan("research_list");
    runPlan("research_search");
    runPlan("status");
    runPlan("node_add");
    runPlan("node_list");
    runPlan("node_update");
    runPlan("node_move");
    runPlan("node_resolve");
    runPlan("evidence_add");
    runPlan("evidence_archive");
    runPlan("evidence_list");
    runPlan("evidence_show");
    runPlan("evidence_verify");
    runPlan("evidence_link");
    runPlan("graph_link");
    runPlan("graph_show");
    runPlan("graph_check");
    runPlan("graph_snapshot");
    runPlan("version_list");
    runPlan("artifact_add");
    runPlan("artifact_list");
    runPlan("run");
    runPlan("gate_check");
    runPlan("artifact_export");
    runPlan("graph_export");
    runPlan("graph_visualize");
    runPlan("db_status");
    runPlan("db_migrate");
    runPlan("db_doctor");
    runPlan("doctor");
    runPlan("sidecar_setup");
    runPlan("export");
    runPlan("branch_list");
    runPlan("branch_create");
    runPlan("branch_switch");
    runPlan("branch_diff");
    runPlan("branch_archive");
    runPlan("node_remove");

    expect([...executedCommands].sort()).toEqual(discoveredCommands);
  }, 60000);
});
