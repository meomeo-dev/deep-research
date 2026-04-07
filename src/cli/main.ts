#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { isAppError } from "../shared/errors";
import { addGlobalOptions, createContext } from "./context";
import { exportGraphPng } from "./graph-png-export";
import { openGraphVisualizer, renderGraphVisualizer } from "./graph-visualizer";
import { writeError, writeSuccess } from "./output";
import { resolveRecentRef } from "./recent-refs";

const ensureNonInteractiveApproval = (context: ReturnType<typeof createContext>): void => {
  if (context.options.noInput && !context.options.yes) {
    throw new Error("Dangerous operation requires --yes when --no-input is set.");
  }
};

const resolveNodeRef = (context: ReturnType<typeof createContext>, value: string): string =>
  resolveRecentRef(context.paths, value, "node") ?? value;

const resolveEvidenceRef = (context: ReturnType<typeof createContext>, value: string): string =>
  resolveRecentRef(context.paths, value, "evidence") ?? value;

const resolveBranchRef = (context: ReturnType<typeof createContext>, value: string): string =>
  resolveRecentRef(context.paths, value, "branch") ?? value;

const outputOptionsFor = (context: ReturnType<typeof createContext>) => ({
  ...context.options,
  paths: context.paths
});

const ensureReportGatesIfNeeded = (
  context: ReturnType<typeof createContext>,
  researchId?: string,
  branchName?: string
): void => {
  if (context.options.format === "json") {
    return;
  }
  context.service.ensureReportExecutionGates(researchId, branchName);
};

const HELP_TEXT = {
  artifactBody: "Full artifact body text to persist.",
  artifactKind: "Artifact kind, such as conclusion_summary or report.",
  archiveBackend: "Archive backend: crawl4ai or node. Defaults to crawl4ai.",
  archiveBackendEndpoint:
    "Explicit TCP fallback endpoint for a Crawl4AI sidecar. Secure defaults use a local manifest plus Unix socket transport instead.",
  branch: "Branch name. Defaults to the active branch.",
  branchForkSource: "Source branch name or version id to fork from.",
  branchId: "Branch id to attach the artifact to.",
  branchName: "Branch name to create, switch, or archive.",
  branchRef: "Branch name or @last-branch recent reference.",
  evidence: "Evidence id or @last-evidence recent reference.",
  fromNode: "Source node id or @last-node recent reference.",
  node: "Node id or @last-node recent reference.",
  nodeKind:
    "Node kind: question, hypothesis, evidence, finding, gap, task, conclusion, or note.",
  notes: "Verification notes recorded with the evidence item.",
  publishedAt: "Evidence publication timestamp in ISO-8601 format.",
  query: "Search text matched against research, node, evidence, and artifact content.",
  reason: "Human-readable reason stored with the branch or snapshot event.",
  relation: "Relation kind: supports, refutes, or annotates.",
  researchId: "Research id. Defaults to the active research.",
  source: "Canonical source URI or locator for the evidence item.",
  title: "Short human-readable title.",
  timeoutMs: "Archive request timeout in milliseconds.",
  toNode: "Target node id or @last-node recent reference.",
  trustLevel: "Numeric trust level for the evidence item.",
  versionId: "Version id to attach the artifact to.",
  workflowState: "Workflow state for the node, such as active, ready, or resolved.",
  epistemicState:
    "Epistemic state for the node, such as untested, supported, or inconclusive.",
  body: "Detailed body text stored with the record.",
  edgeKind: "Edge kind: supports, refutes, depends_on, derived_from, or annotates.",
  question: "Primary research question for the new research record.",
  runMode: "Lifecycle stage to advance: plan, evidence, synthesize, review, or complete."
} as const;

const ROOT_HELP_GROUPS = [
  {
    commands: ["init", "research_list", "research_search", "status", "run", "gate_check", "export"],
    title: "Research"
  },
  {
    commands: [
      "version_list",
      "branch_list",
      "branch_create",
      "branch_switch",
      "branch_diff",
      "branch_archive"
    ],
    title: "Branch"
  },
  {
    commands: ["node_list", "node_add", "node_update", "node_resolve", "node_move", "node_remove"],
    title: "Node"
  },
  {
    commands: [
      "evidence_list",
      "evidence_add",
      "evidence_archive",
      "evidence_show",
      "evidence_link",
      "evidence_verify"
    ],
    title: "Evidence"
  },
  {
    commands: [
      "graph_show",
      "graph_check",
      "graph_snapshot",
      "graph_export",
      "graph_visualize",
      "graph_link"
    ],
    title: "Graph"
  },
  {
    commands: ["artifact_list", "artifact_add", "artifact_export"],
    title: "Artifact"
  },
  {
    commands: ["db_status", "db_migrate", "db_doctor", "doctor", "sidecar_setup"],
    title: "Health"
  }
] as const;

const chunkCommands = (
  commands: readonly string[],
  size: number
): string[][] => {
  const lines: string[][] = [];

  for (let index = 0; index < commands.length; index += size) {
    lines.push([...commands.slice(index, index + size)]);
  }

  return lines;
};

const renderRootHelpQuickReference = (): string =>
  [
    "",
    "Grouped quick reference:",
    ...ROOT_HELP_GROUPS.flatMap(({ commands, title }) => [
      `  ${title}:`,
      ...chunkCommands(commands, 3).map((line) => `    ${line.join(", ")}`)
    ])
  ].join("\n");

const addCommand = (
  program: Command,
  name: string,
  description: string
): Command => addGlobalOptions(program.command(name).description(description));

const inferInvokedCommand = (argv: string[]): string => argv[2] ?? "unknown";

export const buildProgram = (): Command => {
  const program = addGlobalOptions(
    new Command()
      .name("deep-research")
      .description("Manage versioned deep research workflows backed by SQLite.")
      .showHelpAfterError()
  );

  program.addHelpText("after", renderRootHelpQuickReference());

  program
    .command("init")
    .description("Initialize a new research in the current project database")
    .requiredOption("--title <text>", HELP_TEXT.title)
    .requiredOption("--question <text>", HELP_TEXT.question)
    .option("--force", "Allow running init even if research records already exist")
    .action((options, command) => {
      const context = createContext(command);
      try {
        if (!options.force && context.service.listResearchs().length > 0) {
          throw new Error("Research records already exist. Use --force to create another one.");
        }
        const result = context.service.initResearch({
          question: String(options.question),
          title: String(options.title)
        });
        writeSuccess("init", result, outputOptionsFor(context));
      } finally {
        context.close();
      }
    });

  addCommand(program, "research_list", "List research history").action(
    (_options, command) => {
      const context = createContext(command);
      try {
        writeSuccess("research_list", context.service.listResearchs(), context.options);
      } finally {
        context.close();
      }
    }
  );
  addCommand(
    program,
    "research_search",
    "Search research history by title, question, node, evidence, or artifact text"
  )
    .argument("<query>", HELP_TEXT.query)
    .action((query, _options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "research_search",
          context.service.listResearchs(String(query)),
          context.options
        );
      } finally {
        context.close();
      }
    });

  program
    .command("status")
    .description("Show the active research and branch status")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "status",
          context.service.getStatus(options.researchId, options.branch),
          context.options
        );
      } finally {
        context.close();
      }
    });

  program
    .command("run")
    .description("Advance the current research lifecycle")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option(
      "--mode <plan|evidence|synthesize|review|complete>",
      HELP_TEXT.runMode,
      "plan"
    )
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "run",
          context.service.advanceResearch(options.mode, options.researchId),
          context.options
        );
      } finally {
        context.close();
      }
    });

  program
    .command("gate_check")
    .description("Validate execution gates before final reporting")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
      const context = createContext(command);
      try {
        const report = context.service.ensureReportExecutionGates(options.researchId, options.branch);
        writeSuccess("gate_check", report, context.options);
      } finally {
        context.close();
      }
    });

  addCommand(program, "version_list", "List versions for a branch")
    .description("List versions for a branch")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "version_list",
          context.service.listVersions(options.researchId, options.branch),
          context.options
        );
      } finally {
        context.close();
      }
    });

  addCommand(program, "branch_list", "List branches")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .action((options, command) => {
    const context = createContext(command);
    try {
      writeSuccess("branch_list", context.service.listBranches(options.researchId), context.options);
    } finally {
      context.close();
    }
  });
  addCommand(program, "branch_create", "Create a branch from the current branch or a named source")
    .description("Create a branch from the current branch or a named source")
    .requiredOption("--name <branch>", HELP_TEXT.branchName)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--from <branch-or-version>", HELP_TEXT.branchForkSource)
    .option("--reason <text>", "Reason for the fork", "Fork branch")
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "branch_create",
          context.service.createBranch(
            String(options.name),
            String(options.reason),
            options.researchId,
            options.from
          ),
          outputOptionsFor(context)
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "branch_switch", "Switch the active branch")
    .description("Switch the active branch")
    .requiredOption("--name <branch>", HELP_TEXT.branchRef)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "branch_switch",
          context.service.switchBranch(resolveBranchRef(context, String(options.name)), options.researchId),
          context.options
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "branch_diff", "Compare two branches")
    .description("Compare two branches")
    .requiredOption("--left <branch>", "Left branch name to compare.")
    .requiredOption("--right <branch>", "Right branch name to compare.")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "branch_diff",
          context.service.diffBranches(
            String(options.left),
            String(options.right),
            options.researchId
          ),
          context.options
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "branch_archive", "Archive a branch")
    .description("Archive a branch")
    .requiredOption("--name <branch>", HELP_TEXT.branchRef)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .action((options, command) => {
      const context = createContext(command);
      try {
        ensureNonInteractiveApproval(context);
        writeSuccess(
          "branch_archive",
          context.service.archiveBranch(String(options.name), options.researchId),
          context.options
        );
      } finally {
        context.close();
      }
    });

  addCommand(program, "node_list", "List nodes for the active branch")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
    const context = createContext(command);
    try {
      writeSuccess("node_list", context.service.listNodes(options.researchId, options.branch), context.options);
    } finally {
      context.close();
    }
  });
  addCommand(program, "node_add", "Add a node to the active branch")
    .description("Add a node to the active branch")
    .requiredOption("--kind <kind>", HELP_TEXT.nodeKind)
    .requiredOption("--title <text>", HELP_TEXT.title)
    .option("--body <text>", HELP_TEXT.body)
    .option("--workflow-state <state>", HELP_TEXT.workflowState)
    .option("--epistemic-state <state>", HELP_TEXT.epistemicState)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "node_add",
          context.service.addNode({
            body: options.body,
            branchName: options.branch,
            epistemicState: options.epistemicState,
            kind: options.kind,
            researchId: options.researchId,
            title: options.title,
            workflowState: options.workflowState
          }),
          outputOptionsFor(context)
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "node_update", "Update a node on the active branch")
    .description("Update a node on the active branch")
    .requiredOption("--node <id>", HELP_TEXT.node)
    .option("--title <text>", HELP_TEXT.title)
    .option("--body <text>", HELP_TEXT.body)
    .option("--workflow-state <state>", HELP_TEXT.workflowState)
    .option("--epistemic-state <state>", HELP_TEXT.epistemicState)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "node_update",
          context.service.updateNode({
            body: options.body,
            branchName: options.branch,
            epistemicState: options.epistemicState,
            nodeId: resolveNodeRef(context, String(options.node)),
            researchId: options.researchId,
            title: options.title,
            workflowState: options.workflowState
          }),
          context.options
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "node_resolve", "Mark a node as resolved and supported")
    .description("Mark a node as resolved and supported")
    .requiredOption("--node <id>", HELP_TEXT.node)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "node_resolve",
          context.service.resolveNode(
            resolveNodeRef(context, String(options.node)),
            options.researchId,
            options.branch
          ),
          context.options
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "node_move", "Update node ordering metadata")
    .description("Update node ordering metadata")
    .requiredOption("--node <id>", HELP_TEXT.node)
    .option("--before <id>", "Place the node before this sibling node id.")
    .option("--after <id>", "Place the node after this sibling node id.")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "node_move",
          context.service.moveNode({
            afterNodeId: options.after ? resolveNodeRef(context, String(options.after)) : undefined,
            beforeNodeId: options.before ? resolveNodeRef(context, String(options.before)) : undefined,
            branchName: options.branch,
            nodeId: resolveNodeRef(context, String(options.node)),
            researchId: options.researchId
          }),
          context.options
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "node_remove", "Soft-delete a node from the active branch")
    .description("Soft-delete a node from the active branch")
    .requiredOption("--node <id>", HELP_TEXT.node)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
      const context = createContext(command);
      try {
        ensureNonInteractiveApproval(context);
        writeSuccess(
          "node_remove",
          context.service.removeNode(
            resolveNodeRef(context, String(options.node)),
            options.researchId,
            options.branch
          ),
          context.options
        );
      } finally {
        context.close();
      }
    });

  addCommand(program, "evidence_list", "List evidence")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .action((options, command) => {
    const context = createContext(command);
    try {
      writeSuccess("evidence_list", context.service.listEvidence(options.researchId), context.options);
    } finally {
      context.close();
    }
  });
  addCommand(program, "evidence_add", "Add an evidence item")
    .description("Add an evidence item")
    .requiredOption("--source <uri>", HELP_TEXT.source)
    .requiredOption("--title <text>", HELP_TEXT.title)
    .option("--summary <text>", "Short evidence summary used during review and export.")
    .option("--trust-level <n>", HELP_TEXT.trustLevel)
    .option("--published-at <iso>", HELP_TEXT.publishedAt)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "evidence_add",
          context.service.addEvidence({
            publishedAt: options.publishedAt,
            researchId: options.researchId,
            sourceUri: options.source,
            summary: options.summary,
            title: options.title,
            trustLevel: options.trustLevel ? Number(options.trustLevel) : undefined
          }),
          outputOptionsFor(context)
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "evidence_archive", "Archive a source URI as evidence")
    .description("Archive a source URI as evidence")
    .requiredOption("--source <uri>", HELP_TEXT.source)
    .option("--title <text>", HELP_TEXT.title)
    .option("--summary <text>", "Short evidence summary used during review and export.")
    .option("--trust-level <n>", HELP_TEXT.trustLevel)
    .option("--published-at <iso>", HELP_TEXT.publishedAt)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--backend <crawl4ai|node>", HELP_TEXT.archiveBackend, "crawl4ai")
    .option("--backend-endpoint <url>", HELP_TEXT.archiveBackendEndpoint)
    .option("--timeout-ms <n>", HELP_TEXT.timeoutMs, "15000")
    .action(async (options, command) => {
      const context = createContext(command);
      try {
        if (options.backend === "crawl4ai" && !options.backendEndpoint) {
          await context.ensureManagedCrawl4aiSidecar();
        }
        writeSuccess(
          "evidence_archive",
          await context.service.archiveEvidence({
            backend: options.backend,
            backendEndpoint: options.backendEndpoint,
            publishedAt: options.publishedAt,
            researchId: options.researchId,
            sidecarManifestPath: context.paths.sidecarManifestPath,
            sourceUri: options.source,
            summary: options.summary,
            timeoutMs: Number(options.timeoutMs),
            title: options.title,
            trustLevel: options.trustLevel ? Number(options.trustLevel) : undefined
          }),
          outputOptionsFor(context)
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "evidence_show", "Show an evidence item and its links")
    .description("Show an evidence item and its links")
    .requiredOption("--evidence <id>", HELP_TEXT.evidence)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "evidence_show",
          context.service.showEvidence(resolveEvidenceRef(context, String(options.evidence))),
          context.options
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "evidence_link", "Link an evidence item to a node")
    .description("Link an evidence item to a node")
    .requiredOption("--node <id>", HELP_TEXT.node)
    .requiredOption("--evidence <id>", HELP_TEXT.evidence)
    .requiredOption("--relation <kind>", HELP_TEXT.relation)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "evidence_link",
          context.service.linkEvidence({
            evidenceId: resolveEvidenceRef(context, String(options.evidence)),
            nodeId: resolveNodeRef(context, String(options.node)),
            relation: options.relation,
            researchId: options.researchId
          }),
          context.options
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "evidence_verify", "Mark an evidence item as verified")
    .description("Mark an evidence item as verified")
    .requiredOption("--evidence <id>", HELP_TEXT.evidence)
    .option("--notes <text>", HELP_TEXT.notes, "Verified")
    .option("--trust-level <n>", HELP_TEXT.trustLevel)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "evidence_verify",
          context.service.verifyEvidence(
            resolveEvidenceRef(context, String(options.evidence)),
            options.notes,
            options.researchId,
            options.trustLevel ? Number(options.trustLevel) : undefined
          ),
          context.options
        );
      } finally {
        context.close();
      }
    });

  addCommand(program, "graph_show", "Show the current branch graph")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
    const context = createContext(command);
    try {
      writeSuccess("graph_show", context.service.showGraph(options.researchId, options.branch), context.options);
    } finally {
      context.close();
    }
  });
  addCommand(program, "graph_check", "Validate DAG invariants")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
    const context = createContext(command);
    try {
      writeSuccess("graph_check", context.service.checkGraph(options.researchId, options.branch), context.options);
    } finally {
      context.close();
    }
  });
  addCommand(program, "graph_snapshot", "Create a new graph snapshot version")
    .description("Create a new graph snapshot version")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .option("--reason <text>", HELP_TEXT.reason, "Manual snapshot")
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "graph_snapshot",
          context.service.createSnapshot(options.reason, options.researchId, options.branch),
          context.options
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "graph_export", "Export the current graph")
    .description("Export the current graph")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .option(
      "--export-format <text|png>",
      "Plain output artifact format. Use png to rasterize the current DAG.",
      "text"
    )
    .option(
      "--scale <n>",
      "PNG scale multiplier. Higher values increase resolution and file size."
    )
    .option(
      "--max-bytes <n>",
      "Maximum PNG file size in bytes before export aborts or downscales.",
      "10485760"
    )
    .action(async (options, command) => {
      const context = createContext(command);
      try {
        if (options.exportFormat === "png") {
          const graph = context.service.showGraph(options.researchId, options.branch) as {
            branch: Parameters<typeof exportGraphPng>[0]["branch"];
            edges: Parameters<typeof exportGraphPng>[0]["edges"];
            evidenceByNode: Parameters<typeof exportGraphPng>[0]["evidenceByNode"];
            nodes: Parameters<typeof exportGraphPng>[0]["nodes"];
          };
          const outputPath = context.options.output
            ? path.resolve(context.paths.projectRoot, String(context.options.output))
            : undefined;
          const result = await exportGraphPng({
            branch: graph.branch,
            edges: graph.edges,
            evidenceByNode: graph.evidenceByNode,
            maxBytes: Number(options.maxBytes),
            nodes: graph.nodes,
            outputPath,
            projectRoot: context.paths.projectRoot,
            scale: options.scale ? Number(options.scale) : undefined
          });
          writeSuccess(
            "graph_export",
            {
              ...result,
              exportFormat: "png"
            },
            {
              ...context.options,
              output: undefined
            }
          );
          return;
        }

        writeSuccess(
          "graph_export",
          context.options.format === "json"
            ? context.service.showGraph(options.researchId, options.branch)
            : context.service.exportGraph(options.researchId, options.branch),
          context.options
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "graph_visualize", "Generate a local SPA HTML DAG visualizer")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .option("--html-path <path>", "Write the generated SPA HTML to a specific path")
    .option("--open", "Open the generated SPA HTML in the system browser")
    .action(async (options, command) => {
      const context = createContext(command);
      try {
        const graph = context.service.showGraph(options.researchId, options.branch) as {
          branch: Parameters<typeof renderGraphVisualizer>[0]["branch"];
          edges: Parameters<typeof renderGraphVisualizer>[0]["edges"];
          evidenceByNode: Parameters<typeof renderGraphVisualizer>[0]["evidenceByNode"];
          nodes: Parameters<typeof renderGraphVisualizer>[0]["nodes"];
        };
        const outputPath = options.htmlPath
          ? path.resolve(context.paths.projectRoot, String(options.htmlPath))
          : context.options.output && context.options.format === "plain" && context.options.outputMode !== "envelope"
            ? path.resolve(context.paths.projectRoot, String(context.options.output))
          : undefined;
        const result = await renderGraphVisualizer({
          branch: graph.branch,
          edges: graph.edges,
          evidenceByNode: graph.evidenceByNode,
          nodes: graph.nodes,
          outputPath,
          projectRoot: context.paths.projectRoot
        });
        if (options.open) {
          openGraphVisualizer(result.htmlPath);
        }
        writeSuccess(
          "graph_visualize",
          {
            ...result,
            openedInBrowser: Boolean(options.open)
          },
          context.options
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "graph_link", "Create an edge between two nodes")
    .description("Create an edge between two nodes")
    .requiredOption("--from <node>", HELP_TEXT.fromNode)
    .requiredOption("--to <node>", HELP_TEXT.toNode)
    .requiredOption("--kind <edge-kind>", HELP_TEXT.edgeKind)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch <name>", HELP_TEXT.branch)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "graph_link",
          context.service.addEdge({
            branchName: options.branch,
            fromNodeId: resolveNodeRef(context, String(options.from)),
            kind: options.kind,
            researchId: options.researchId,
            toNodeId: resolveNodeRef(context, String(options.to))
          }),
          context.options
        );
      } finally {
        context.close();
      }
    });

  addCommand(program, "artifact_list", "List artifacts")
    .description("List artifacts")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "artifact_list",
          context.service.listArtifacts(options.researchId),
          context.options
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "artifact_add", "Add an artifact")
    .description("Add an artifact")
    .requiredOption("--kind <kind>", HELP_TEXT.artifactKind)
    .requiredOption("--title <text>", HELP_TEXT.title)
    .requiredOption("--body <text>", HELP_TEXT.artifactBody)
    .option("--research-id <id>", HELP_TEXT.researchId)
    .option("--branch-id <id>", HELP_TEXT.branchId)
    .option("--version-id <id>", HELP_TEXT.versionId)
    .option("--node-id <id>", HELP_TEXT.node)
    .action((options, command) => {
      const context = createContext(command);
      try {
        writeSuccess(
          "artifact_add",
          context.service.addArtifact({
            artifactKind: options.kind,
            body: options.body,
            branchId: options.branchId,
            nodeId: options.nodeId ? resolveNodeRef(context, String(options.nodeId)) : undefined,
            researchId: options.researchId,
            title: options.title,
            versionId: options.versionId
          }),
          outputOptionsFor(context)
        );
      } finally {
        context.close();
      }
    });
  addCommand(program, "artifact_export", "Export artifacts as a report")
    .description("Export artifacts as a report")
    .option("--research-id <id>", HELP_TEXT.researchId)
    .action((options, command) => {
      const context = createContext(command);
      try {
        ensureReportGatesIfNeeded(context, options.researchId);
        writeSuccess(
          "artifact_export",
          context.options.format === "json"
            ? context.service.listArtifacts(options.researchId)
            : context.service.exportArtifacts(options.researchId),
          context.options
        );
      } finally {
        context.close();
      }
    });

  addCommand(program, "db_status", "Show database path and migration status").action((_options, command) => {
    const context = createContext(command);
    try {
      writeSuccess(
        "db_status",
        {
          dbPath: context.paths.dbPath,
          exists: fs.existsSync(context.paths.dbPath),
          migrationsApplied: context.migrations
        },
        context.options
      );
    } finally {
      context.close();
    }
  });
  addCommand(program, "db_migrate", "Run database migrations").action((_options, command) => {
    const context = createContext(command);
    try {
      writeSuccess(
        "db_migrate",
        { dbPath: context.paths.dbPath, executed: context.migrations },
        context.options
      );
    } finally {
      context.close();
    }
  });
  addCommand(program, "db_doctor", "Check database accessibility").action((_options, command) => {
    const context = createContext(command);
    try {
      writeSuccess(
        "db_doctor",
        {
          dbPath: context.paths.dbPath,
          dbSizeBytes: fs.existsSync(context.paths.dbPath)
            ? fs.statSync(context.paths.dbPath).size
            : 0,
          projectRoot: context.paths.projectRoot
        },
        context.options
      );
    } finally {
      context.close();
    }
  });

  program
    .command("sidecar_setup")
    .description("Inspect or explicitly prepare the managed Crawl4AI sidecar runtime")
    .option("--run-setup", "Create or update the shared program Crawl4AI venv, install requirements, and run crawl4ai-setup")
    .option("--run-doctor", "Run crawl4ai-doctor inside the shared program Crawl4AI venv")
    .action((options, command) => {
      const context = createContext(command);
      try {
        if (options.runSetup && options.runDoctor) {
          throw new Error("sidecar_setup accepts either --run-setup or --run-doctor, not both.");
        }

        const result = options.runSetup
          ? context.runManagedCrawl4aiAction("setup")
          : options.runDoctor
            ? context.runManagedCrawl4aiAction("doctor")
            : context.inspectManagedCrawl4aiSidecar();
        writeSuccess("sidecar_setup", result, context.options);
      } finally {
        context.close();
      }
    });

  program.command("doctor").description("Run a project health check").action((_options, command) => {
    const context = createContext(command);
    try {
      writeSuccess(
        "doctor",
        {
          dbPath: context.paths.dbPath,
          projectRoot: context.paths.projectRoot,
          resources: {
            references: path.join(context.paths.projectRoot, "resources", "references"),
            sidecarRequirements: path.join(context.paths.projectRoot, "resources", "sidecar", "requirements.txt"),
            skill: path.join(context.paths.projectRoot, "SKILL.md")
          },
          researchCount: context.service.listResearchs().length,
          sidecarRuntime: context.inspectManagedCrawl4aiSidecar()
        },
        context.options
      );
    } finally {
      context.close();
    }
  });

  program.command("export").description("Export a research report").option("--research-id <id>", HELP_TEXT.researchId).option("--branch <name>", HELP_TEXT.branch).action((options, command) => {
    const context = createContext(command);
    try {
      ensureReportGatesIfNeeded(context, options.researchId, options.branch);
      writeSuccess(
        "export",
        context.options.format === "json"
          ? context.service.getStatus(options.researchId, options.branch)
          : context.service.exportReport(options.researchId, options.branch),
        context.options
      );
    } finally {
      context.close();
    }
  });

  return program;
};

const run = async (): Promise<void> => {
  const program = buildProgram();
  if (process.argv.length <= 2) {
    program.outputHelp();
    process.exitCode = 0;
    return;
  }

  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    const command = inferInvokedCommand(process.argv);
    const format = ((process.argv.includes("--format") &&
      process.argv[process.argv.indexOf("--format") + 1]) ||
      "plain") as "plain" | "json";
    const output = process.argv.includes("--output")
      ? process.argv[process.argv.indexOf("--output") + 1]
      : undefined;

    if (isAppError(error)) {
      writeError(
        command,
        error.message,
        { format, output },
        { code: error.code, committed: false, ...(error.details ?? {}) }
      );
      process.exitCode = error.exitCode;
      return;
    }
    if (error instanceof Error) {
      writeError(command, error.message, { format, output });
    } else {
      writeError(command, "Unknown failure.", { format, output });
    }
    process.exitCode = 1;
  }
};

void run();