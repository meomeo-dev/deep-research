import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const tempRoots: string[] = [];
const distCliEntry = path.join(process.cwd(), "dist", "cli", "main.js");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

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

const runDistCli = (args: string[]): CliResult => {
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
  args: string[] = []
): Envelope<T> => {
  executed.add(command);
  const result = runDistCli(["--project", fixtureRoot, "--format", "json", command, ...args]);
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
  const buildResult = spawnSync(packageManager, ["build"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env
  });

  expect(buildResult.status ?? 1).toBe(0);
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
          "E2E root question"
        ]).data.id;
        state.hypothesisNodeId = runJsonCommand<NodeRecord>(executedCommands, fixtureRoot, "node_add", [
          "--kind",
          "hypothesis",
          "--title",
          "E2E hypothesis"
        ]).data.id;
        state.findingNodeId = runJsonCommand<NodeRecord>(executedCommands, fixtureRoot, "node_add", [
          "--kind",
          "finding",
          "--title",
          "E2E finding"
        ]).data.id;
        state.gapNodeId = runJsonCommand<NodeRecord>(executedCommands, fixtureRoot, "node_add", [
          "--kind",
          "gap",
          "--title",
          "E2E gap"
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
          "E2E conclusion"
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
        runJsonCommand(executedCommands, fixtureRoot, "run", ["--mode", "review"]);
      },
      status: () => {
        runJsonCommand(executedCommands, fixtureRoot, "status");
      },
      version_list: () => {
        runJsonCommand(executedCommands, fixtureRoot, "version_list", ["--branch", "main"]);
      }
    } satisfies Record<string, CommandPlan>;

    const runPlan = (command: keyof typeof commandPlans): void => {
      commandPlans[command]();
    };

    expect(Object.keys(commandPlans).sort()).toEqual(discoveredCommands);

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
    runPlan("artifact_export");
    runPlan("graph_export");
    runPlan("graph_visualize");
    runPlan("db_status");
    runPlan("db_migrate");
    runPlan("db_doctor");
    runPlan("doctor");
    runPlan("run");
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
