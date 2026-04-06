import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { BranchRecord } from "../domain/contracts";
import type { GraphRenderInput } from "./graph-rendering";
import {
  computeGraphLayout,
  defaultGraphHtmlOutputPath,
  escapeHtml,
  type GraphLayoutEdge,
  type GraphLayoutNode
} from "./graph-rendering";

export interface GraphVisualizerInput extends GraphRenderInput {}

export interface GraphVisualizerResult {
  branchName: string;
  edgeCount: number;
  htmlPath: string;
  nodeCount: number;
}

export const renderGraphVisualizer = async (
  input: GraphVisualizerInput
): Promise<GraphVisualizerResult> => {
  const htmlPath =
    input.outputPath ?? defaultGraphHtmlOutputPath(input.projectRoot, input.branch.name);
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });

  const { edges, layoutNodes, viewport } = await computeGraphLayout(
    input.nodes,
    input.edges,
    input.evidenceByNode
  );
  const html = buildHtml({
    branch: input.branch,
    edges,
    htmlPath,
    nodes: layoutNodes,
    viewport
  });

  fs.writeFileSync(htmlPath, html, "utf8");

  return {
    branchName: input.branch.name,
    edgeCount: input.edges.length,
    htmlPath,
    nodeCount: input.nodes.length
  };
};

export const openGraphVisualizer = (htmlPath: string): void => {
  const target = path.resolve(htmlPath);
  const openArgs =
    process.platform === "darwin"
      ? { command: "open", args: [target] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", target] }
        : { command: "xdg-open", args: [target] };

  const child = spawn(openArgs.command, openArgs.args, {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
};

const buildHtml = (input: {
  branch: BranchRecord;
  edges: GraphLayoutEdge[];
  htmlPath: string;
  nodes: GraphLayoutNode[];
  viewport: { width: number; height: number };
}): string => {
  const payload = JSON.stringify({
    branch: input.branch,
    edges: input.edges,
    generatedAt: new Date().toISOString(),
    htmlPath: input.htmlPath,
    nodes: input.nodes,
    viewport: input.viewport
  }).replaceAll("<", "\\u003c");

  return readTemplate()
    .replaceAll("__GRAPH_TITLE__", escapeHtml(input.branch.name))
    .replaceAll("__BRANCH_NAME__", escapeHtml(input.branch.name))
    .replaceAll("__NODE_COUNT__", String(input.nodes.length))
    .replaceAll("__EDGE_COUNT__", String(input.edges.length))
    .replaceAll("__VIEWBOX_WIDTH__", String(input.viewport.width))
    .replaceAll("__VIEWBOX_HEIGHT__", String(input.viewport.height))
    .replaceAll("__PAYLOAD_JSON__", payload);
};

const readTemplate = (): string => fs.readFileSync(resolveTemplatePath(), "utf8");

const resolveTemplatePath = (): string => {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, "../../resources/templates/graph-visualizer.template.html"),
    path.resolve(currentDir, "../resources/templates/graph-visualizer.template.html")
  ];

  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error("Graph visualizer template was not found.");
  }
  return match;
};
