/* global console, process */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");
const cliBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cliBaseArgs = ["exec", "tsx", "src/cli/main.ts"];
const demoRoot = path.join(__dirname, "project");
const outputPngPath = path.join(__dirname, "leading-symbol-font-fallback-demo.png");
const outputHtmlPath = path.join(__dirname, "leading-symbol-font-fallback-demo.html");
const summaryPath = path.join(__dirname, "leading-symbol-font-fallback-demo.summary.json");

const nodes = [
  [
    "RQ",
    "question",
    "Leading neutral symbol fallback stays stable across PNG export",
    "This root node anchors the regression demo and ensures the exported DAG remains easy to inspect visually.",
    "active",
    "untested"
  ],
  [
    "LATIN_LEADING",
    "finding",
    "→ Mixed 混排 title",
    "• English title",
    "resolved",
    "supported"
  ],
  [
    "CJK_LEADING",
    "finding",
    "- 中文标题",
    "【标记】English 与 中文",
    "resolved",
    "supported"
  ],
  [
    "INLINE_NEUTRAL",
    "note",
    "Inline punctuation should stick to the previous strong script",
    "English • 中文 / 中文 → English",
    "resolved",
    "supported"
  ],
  [
    "NEUTRAL_ONLY",
    "gap",
    "Neutral-only runs need a stable fallback",
    "• → -",
    "ready",
    "inconclusive"
  ],
  [
    "CONC",
    "conclusion",
    "Neutral symbol assignment no longer depends on raw codepoint buckets",
    "Leading neutral runs now follow the next strong script, inline neutral runs inherit the previous one, and neutral-only text falls back to the Latin stack.",
    "resolved",
    "supported"
  ]
];

const edges = [
  ["RQ", "LATIN_LEADING", "supports"],
  ["RQ", "CJK_LEADING", "supports"],
  ["LATIN_LEADING", "INLINE_NEUTRAL", "annotates"],
  ["CJK_LEADING", "INLINE_NEUTRAL", "annotates"],
  ["INLINE_NEUTRAL", "CONC", "supports"],
  ["NEUTRAL_ONLY", "CONC", "supports"]
];

const runCli = (args) => {
  const result = spawnSync(cliBinary, [...cliBaseArgs, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${args.join(" ")}`,
        result.stdout,
        result.stderr
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return result.stdout.trim();
};

const ensureEmptyProject = () => {
  fs.mkdirSync(demoRoot, { recursive: true });
  const dbPath = path.join(demoRoot, ".deep-research", "deep-research.db");
  if (fs.existsSync(dbPath)) {
    throw new Error(`Demo project already exists at ${demoRoot}. Remove it before rerunning this script.`);
  }
};

const addNodes = () => {
  for (const [, kind, title, body, workflowState, epistemicState] of nodes) {
    runCli([
      "node_add",
      "--project",
      demoRoot,
      "--kind",
      kind,
      "--title",
      title,
      "--body",
      body,
      "--workflow-state",
      workflowState,
      "--epistemic-state",
      epistemicState,
      "--format",
      "json"
    ]);
  }
};

const buildIdMap = () => {
  const payload = JSON.parse(runCli(["node_list", "--project", demoRoot, "--format", "json"]));
  const idMap = new Map();
  for (const node of payload.data) {
    idMap.set(node.title, node.id);
  }
  return idMap;
};

const addEdges = () => {
  const titleByKey = new Map(nodes.map(([key, , title]) => [key, title]));
  const idMap = buildIdMap();

  for (const [fromKey, toKey, kind] of edges) {
    const fromId = idMap.get(titleByKey.get(fromKey));
    const toId = idMap.get(titleByKey.get(toKey));
    if (!fromId || !toId) {
      throw new Error(`Missing node for edge ${fromKey} -> ${toKey}`);
    }

    runCli([
      "graph_link",
      "--project",
      demoRoot,
      "--from",
      String(fromId),
      "--to",
      String(toId),
      "--kind",
      kind,
      "--format",
      "json"
    ]);
  }
};

const snapshot = (reason) => {
  runCli([
    "graph_snapshot",
    "--project",
    demoRoot,
    "--reason",
    reason,
    "--format",
    "json"
  ]);
};

const main = () => {
  ensureEmptyProject();

  runCli([
    "init",
    "--project",
    demoRoot,
    "--title",
    "Leading symbol font fallback regression demo",
    "--question",
    "Does DAG export keep neutral symbols attached to the correct font family across Latin, CJK, mixed, and neutral-only text?",
    "--format",
    "json"
  ]);

  runCli(["run", "--project", demoRoot, "--mode", "plan", "--format", "json"]);
  addNodes();
  addEdges();
  snapshot("Leading symbol font fallback regression locked");

  const graphCheck = JSON.parse(runCli(["graph_check", "--project", demoRoot, "--format", "json"]));
  const exportPayload = JSON.parse(
    runCli([
      "graph_export",
      "--project",
      demoRoot,
      "--export-format",
      "png",
      "--output",
      outputPngPath,
      "--format",
      "json"
    ])
  );
  const visualizePayload = JSON.parse(
    runCli([
      "graph_visualize",
      "--project",
      demoRoot,
      "--html-path",
      outputHtmlPath,
      "--format",
      "json"
    ])
  );
  const graphPayload = JSON.parse(runCli(["graph_show", "--project", demoRoot, "--format", "json"]));

  const summary = {
    title: "Leading symbol font fallback regression demo",
    projectRoot: demoRoot,
    nodeCount: graphPayload.data.nodes.length,
    edgeCount: graphPayload.data.edges.length,
    graphCheck,
    pngExport: exportPayload.data,
    htmlPath: visualizePayload.data.htmlPath,
    focusCases: [
      "• English title",
      "- 中文标题",
      "→ Mixed 混排 title",
      "English • 中文 / 中文 → English",
      "• → -"
    ]
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
};

main();
