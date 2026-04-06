import ELK from "elkjs/lib/elk.bundled.js";
import path from "node:path";
import type {
  BranchRecord,
  EdgeView,
  GraphEvidenceSummaryView,
  NodeView
} from "../domain/contracts";

export interface GraphRenderInput {
  branch: BranchRecord;
  edges: EdgeView[];
  evidenceByNode: Record<string, GraphEvidenceSummaryView[]>;
  nodes: NodeView[];
  outputPath?: string;
  projectRoot: string;
}

export interface GraphViewport {
  height: number;
  width: number;
}

export interface GraphLayoutNode extends NodeView {
  cardHeight: number;
  column: number;
  evidence: GraphEvidenceSummaryView[];
  incoming: number;
  outgoing: number;
  x: number;
  y: number;
}

export interface GraphLayoutEdge extends EdgeView {
  fromX: number;
  fromY: number;
  routePoints: Array<{ x: number; y: number }>;
  svgPath: string;
  toX: number;
  toY: number;
}

interface ElkLayoutPoint {
  x?: number;
  y?: number;
}

interface ElkLayoutSection {
  bendPoints?: ElkLayoutPoint[];
  endPoint?: ElkLayoutPoint;
  startPoint?: ElkLayoutPoint;
}

interface ElkLayoutEdge {
  id?: string;
  sections?: ElkLayoutSection[];
}

interface WrapTextOptions {
  maxCharsPerLine: number;
  maxLines: number;
}

interface NodeCardModel {
  bodyLines: string[];
  bodyY: number;
  dividerY: number;
  footerText: string;
  footerY: number;
  headerLines: string[];
  headerY: number;
  height: number;
  titleLines: string[];
  titleY: number;
}

const CARD = {
  bodyMaxChars: 32,
  bodyLineHeight: 16,
  bodyMaxLines: 5,
  footerGap: 20,
  footerLineHeight: 12,
  minHeight: 156,
  metaMaxChars: 34,
  metaLineHeight: 14,
  metaMaxLines: 1,
  paddingX: 16,
  sectionGap: 18,
  textTop: 30,
  titleMaxChars: 26,
  titleLineHeight: 20,
  titleMaxLines: 2,
  width: 216
} as const;

const LAYOUT = {
  bottomPadding: 84,
  leftPadding: 120,
  rightPadding: 120,
  topPadding: 100,
  viewportTopPadding: 24
} as const;

const ELK_LAYOUT_OPTIONS = {
  "elk.algorithm": "layered",
  "elk.direction": "RIGHT",
  "elk.edgeRouting": "SPLINES",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.crossingMinimization.greedySwitch.activationThreshold": "16",
  "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
  "elk.layered.crossingMinimization.semiInteractive": "true",
  "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  "elk.layered.edgeRouting.splines.mode": "SLOPPY",
  "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
  "elk.layered.spacing.edgeNodeBetweenLayers": "84",
  "elk.layered.spacing.nodeNodeBetweenLayers": "168",
  "elk.layered.thoroughness": "10",
  "elk.spacing.edgeEdge": "40",
  "elk.spacing.edgeNode": "32",
  "elk.spacing.nodeNode": "96"
} as const;

const elk = new ELK();

const COLOR_BY_KIND: Record<string, string> = {
  conclusion: "#be123c",
  evidence: "#0369a1",
  finding: "#7c3aed",
  gap: "#dc2626",
  hypothesis: "#2563eb",
  note: "#4b5563",
  question: "#0f766e",
  task: "#b45309"
};

export const defaultGraphHtmlOutputPath = (
  projectRoot: string,
  branchName: string
): string => buildGraphOutputPath(projectRoot, branchName, "visualizations", "html");

export const defaultGraphPngOutputPath = (
  projectRoot: string,
  branchName: string
): string => buildGraphOutputPath(projectRoot, branchName, "exports", "png");

export const computeGraphLayout = async (
  nodes: NodeView[],
  edges: EdgeView[],
  evidenceByNode: Record<string, GraphEvidenceSummaryView[]>
): Promise<{
  edges: GraphLayoutEdge[];
  layoutNodes: GraphLayoutNode[];
  viewport: GraphViewport;
}> => {
  const incomingCounts = new Map<string, number>();
  const outgoingCounts = new Map<string, number>();

  for (const node of nodes) {
    incomingCounts.set(node.id, 0);
    outgoingCounts.set(node.id, 0);
  }

  for (const edge of edges) {
    incomingCounts.set(edge.toNodeId, (incomingCounts.get(edge.toNodeId) ?? 0) + 1);
    outgoingCounts.set(edge.fromNodeId, (outgoingCounts.get(edge.fromNodeId) ?? 0) + 1);
  }

  const nodeMetrics = new Map(
    nodes.map((node) => {
      const evidence = evidenceByNode[node.id] ?? [];
      const incoming = incomingCounts.get(node.id) ?? 0;
      const outgoing = outgoingCounts.get(node.id) ?? 0;
      const card = buildNodeCardModel(
        {
          body: node.body,
          epistemicState: node.epistemicState,
          incoming,
          kind: node.kind,
          outgoing,
          title: node.title,
          workflowState: node.workflowState
        },
        evidence
      );

      return [
        node.id,
        {
          card,
          evidence,
          incoming,
          outgoing
        }
      ];
    })
  );

  const elkLayout = await elk.layout({
    id: "research-graph",
    layoutOptions: ELK_LAYOUT_OPTIONS,
    children: nodes.map((node) => ({
      id: node.id,
      width: CARD.width,
      height: nodeMetrics.get(node.id)?.card.height ?? CARD.minHeight
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.fromNodeId],
      targets: [edge.toNodeId]
    }))
  });

  const laidOutChildren = elkLayout.children ?? [];
  const xPositions = Array.from(
    new Set(laidOutChildren.map((child) => Math.round(child.x ?? 0)).sort((left, right) => left - right))
  );
  const columnByX = new Map(xPositions.map((value, index) => [value, index]));

  const layoutNodes: GraphLayoutNode[] = nodes.map((node) => {
    const placedNode = laidOutChildren.find((child) => child.id === node.id);
    const metrics = nodeMetrics.get(node.id);
    const rawX = Math.round(placedNode?.x ?? 0);

    return {
      ...node,
      cardHeight: metrics?.card.height ?? CARD.minHeight,
      column: columnByX.get(rawX) ?? 0,
      evidence: metrics?.evidence ?? [],
      incoming: metrics?.incoming ?? 0,
      outgoing: metrics?.outgoing ?? 0,
      x: LAYOUT.leftPadding + rawX,
      y: LAYOUT.topPadding + (placedNode?.y ?? 0)
    };
  });

  const layoutNodeMap = new Map(layoutNodes.map((node) => [node.id, node]));
  const elkEdgeMap = new Map<string, ElkLayoutEdge>(
    ((elkLayout.edges ?? []) as ElkLayoutEdge[])
      .filter((edge) => typeof edge.id === "string")
      .map((edge) => [String(edge.id), edge])
  );
  const layoutEdges: GraphLayoutEdge[] = edges.map((edge) => {
    const from = layoutNodeMap.get(edge.fromNodeId);
    const to = layoutNodeMap.get(edge.toNodeId);
    const fallbackStart = {
      x: (from?.x ?? 0) + CARD.width,
      y: (from?.y ?? 0) + Math.round((from?.cardHeight ?? CARD.minHeight) / 2)
    };
    const fallbackEnd = {
      x: to?.x ?? 0,
      y: (to?.y ?? 0) + Math.round((to?.cardHeight ?? CARD.minHeight) / 2)
    };
    const routePoints = collectEdgeRoutePoints(
      elkEdgeMap.get(edge.id),
      fallbackStart,
      fallbackEnd
    );
    return {
      ...edge,
      fromX: routePoints[0]?.x ?? fallbackStart.x,
      fromY: routePoints[0]?.y ?? fallbackStart.y,
      routePoints,
      svgPath: buildEdgeSvgPath(routePoints, fallbackStart, fallbackEnd),
      toX: routePoints.at(-1)?.x ?? fallbackEnd.x,
      toY: routePoints.at(-1)?.y ?? fallbackEnd.y
    };
  });

  const occupiedBounds = measureOccupiedBounds(layoutNodes, layoutEdges);

  return {
    edges: layoutEdges,
    layoutNodes,
    viewport: {
      height: occupiedBounds.maxY + LAYOUT.bottomPadding,
      width: occupiedBounds.maxX + LAYOUT.rightPadding
    }
  };
};

export const buildGraphSvgDocument = (input: {
  branchName: string;
  edges: GraphLayoutEdge[];
  height: number;
  nodes: GraphLayoutNode[];
  renderedHeight?: number;
  renderedWidth?: number;
  width: number;
}): string => {
  const viewWidth = input.width;
  const viewHeight = input.height;
  const renderWidth = input.renderedWidth ?? viewWidth;
  const renderHeight = input.renderedHeight ?? viewHeight;
  const edges = input.edges.map((edge) => renderEdge(edge)).join("\n");
  const nodes = input.nodes.map((node) => renderNode(node)).join("\n");

  return [
    "<svg xmlns=\"http://www.w3.org/2000/svg\"",
    `  width="${renderWidth}" height="${renderHeight}" viewBox="0 0 ${viewWidth} ${viewHeight}" role="img" aria-label="DAG graph for ${escapeHtml(input.branchName)}">`,
    "  <defs>",
    "    <linearGradient id=\"paper\" x1=\"0%\" y1=\"0%\" x2=\"100%\" y2=\"100%\">",
    "      <stop offset=\"0%\" stop-color=\"#faf7f1\" />",
    "      <stop offset=\"100%\" stop-color=\"#f5f1e8\" />",
    "    </linearGradient>",
    "    <filter id=\"card-shadow\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"160%\">",
    "      <feDropShadow dx=\"0\" dy=\"10\" stdDeviation=\"12\" flood-color=\"rgba(15,23,42,0.16)\" />",
    "    </filter>",
    "    <marker id=\"arrow\" viewBox=\"0 0 10 10\" refX=\"9\" refY=\"5\" markerWidth=\"7\" markerHeight=\"7\" orient=\"auto-start-reverse\">",
    "      <path d=\"M 0 0 L 10 5 L 0 10 z\" fill=\"rgba(100, 116, 139, 0.72)\" />",
    "    </marker>",
    "  </defs>",
    `  <rect width="${viewWidth}" height="${viewHeight}" fill="url(#paper)" />`,
    `  <text x="32" y="42" font-family="Avenir Next, Segoe UI, sans-serif" font-size="16" font-weight="700" fill="#1e293b">${escapeHtml(input.branchName)}</text>`,
    `  <text x="32" y="66" font-family="Avenir Next, Segoe UI, sans-serif" font-size="12" fill="#6b7280">Nodes: ${input.nodes.length} · Edges: ${input.edges.length}</text>`,
    `  <g transform="translate(0 ${LAYOUT.viewportTopPadding})">${edges}${nodes}</g>`,
    "</svg>"
  ].join("\n");
};

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const buildGraphOutputPath = (
  projectRoot: string,
  branchName: string,
  folderName: string,
  extension: string
): string => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeBranchName = branchName.replace(/[^a-zA-Z0-9_-]+/g, "-");
  return path.join(
    projectRoot,
    ".deep-research",
    folderName,
    `${safeBranchName || "graph"}-${timestamp}.${extension}`
  );
};

const renderEdge = (edge: GraphLayoutEdge): string => {
  return `
    <path d="${edge.svgPath}" fill="none" stroke="rgba(100, 116, 139, 0.54)" stroke-width="2.5" marker-end="url(#arrow)" />`;
};

const renderNode = (node: GraphLayoutNode): string => {
  const card = buildNodeCardModel(node, node.evidence);
  const accent = COLOR_BY_KIND[node.kind] ?? "#475569";

  return [
    `\n    <g transform="translate(${node.x} ${node.y})" filter="url(#card-shadow)">`,
    `      <rect rx="22" width="${CARD.width}" height="${card.height}" fill="rgba(255,255,255,0.94)" stroke="rgba(15,23,42,0.08)" stroke-width="1.5" />`,
    `      <rect rx="22" width="${CARD.width}" height="8" fill="${accent}" />`,
    renderTextBlock(card.headerLines, CARD.paddingX, card.headerY, 11, CARD.metaLineHeight, "#6b7280", 500, true),
    renderTextBlock(card.titleLines, CARD.paddingX, card.titleY, 14, CARD.titleLineHeight, "#1e293b", 700, false),
    renderTextBlock(card.bodyLines, CARD.paddingX, card.bodyY, 12, CARD.bodyLineHeight, "#334155", 400, false),
    `      <line x1="${CARD.paddingX}" x2="${CARD.width - CARD.paddingX}" y1="${card.dividerY}" y2="${card.dividerY}" stroke="rgba(148,163,184,0.42)" stroke-width="1" />`,
    renderTextBlock([card.footerText], CARD.paddingX, card.footerY, 11, CARD.footerLineHeight, "#6b7280", 600, true),
    "    </g>"
  ].join("\n");
};

const buildNodeCardModel = (
  node: Pick<GraphLayoutNode, "body" | "epistemicState" | "incoming" | "kind" | "outgoing" | "title" | "workflowState">,
  evidence: GraphEvidenceSummaryView[]
): NodeCardModel => {
  const headerLines = wrapSvgText(
    `${node.kind} · ${node.workflowState} · ${node.epistemicState}`,
    {
      maxCharsPerLine: CARD.metaMaxChars,
      maxLines: CARD.metaMaxLines
    }
  );
  const titleLines = wrapSvgText(node.title, {
    maxCharsPerLine: CARD.titleMaxChars,
    maxLines: CARD.titleMaxLines
  });
  const bodyLines = wrapSvgText(node.body || "No body text.", {
    maxCharsPerLine: CARD.bodyMaxChars,
    maxLines: CARD.bodyMaxLines
  });

  const headerY = CARD.textTop;
  const titleY =
    headerY + Math.max(1, headerLines.length - 1) * CARD.metaLineHeight + CARD.sectionGap + 2;
  const bodyY =
    titleY + Math.max(1, titleLines.length - 1) * CARD.titleLineHeight + CARD.sectionGap + 2;
  const dividerY =
    bodyY + Math.max(1, bodyLines.length - 1) * CARD.bodyLineHeight + CARD.footerGap;
  const footerY = dividerY + CARD.footerGap;
  const height = Math.max(CARD.minHeight, footerY + 16);

  return {
    bodyLines,
    bodyY,
    dividerY,
    footerText: `in ${node.incoming} · out ${node.outgoing} · evidence ${evidence.length}`,
    footerY,
    headerLines,
    headerY,
    height,
    titleLines,
    titleY
  };
};

const renderTextBlock = (
  lines: string[],
  x: number,
  y: number,
  fontSize: number,
  lineHeight: number,
  fill: string,
  fontWeight: number,
  uppercase: boolean
): string => {
  const attributes = uppercase ? ' text-transform="uppercase" letter-spacing="0.04em"' : "";
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeHtml(line)}</tspan>`
    )
    .join("");
  return `      <text x="${x}" y="${y}" font-family="Avenir Next, Segoe UI, sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}"${attributes}>${tspans}</text>`;
};

const wrapSvgText = (text: string, options: WrapTextOptions): string[] => {
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) {
    return [""];
  }

  const words = raw.split(" ");
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const parts = breakLongWord(word, options.maxCharsPerLine);
    for (const part of parts) {
      const next = current ? `${current} ${part}` : part;
      if (!current || next.length <= options.maxCharsPerLine) {
        current = next;
        continue;
      }
      lines.push(current);
      current = part;
    }
  }

  if (current) {
    lines.push(current);
  }

  if (lines.length <= options.maxLines) {
    return lines;
  }

  const visible = lines.slice(0, options.maxLines);
  const lastVisibleLine = visible[options.maxLines - 1] ?? "";
  visible[options.maxLines - 1] = clampLine(
    lastVisibleLine,
    options.maxCharsPerLine
  );
  return visible;
};

const breakLongWord = (word: string, maxCharsPerLine: number): string[] => {
  if (word.length <= maxCharsPerLine) {
    return [word];
  }

  const parts: string[] = [];
  for (let index = 0; index < word.length; index += maxCharsPerLine) {
    parts.push(word.slice(index, index + maxCharsPerLine));
  }
  return parts;
};

const clampLine = (line: string, maxCharsPerLine: number): string => {
  if (line.length <= maxCharsPerLine) {
    return line;
  }
  return `${line.slice(0, Math.max(1, maxCharsPerLine - 1))}…`;
};

const collectEdgeRoutePoints = (
  edge: ElkLayoutEdge | undefined,
  fallbackStart: { x: number; y: number },
  fallbackEnd: { x: number; y: number }
): Array<{ x: number; y: number }> => {
  const points: Array<{ x: number; y: number }> = [];

  for (const section of edge?.sections ?? []) {
    appendRoutePoint(points, normalizeElkPoint(section.startPoint));
    for (const bendPoint of section.bendPoints ?? []) {
      appendRoutePoint(points, normalizeElkPoint(bendPoint));
    }
    appendRoutePoint(points, normalizeElkPoint(section.endPoint));
  }

  if (points.length < 2) {
    return [fallbackStart, fallbackEnd];
  }

  points[0] = fallbackStart;
  points[points.length - 1] = fallbackEnd;
  return points;
};

const normalizeElkPoint = (
  point: ElkLayoutPoint | undefined
): { x: number; y: number } | undefined => {
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
    return undefined;
  }

  return {
    x: LAYOUT.leftPadding + point.x,
    y: LAYOUT.topPadding + point.y
  };
};

const appendRoutePoint = (
  points: Array<{ x: number; y: number }>,
  point: { x: number; y: number } | undefined
): void => {
  if (!point) {
    return;
  }

  const previous = points.at(-1);
  if (previous && previous.x === point.x && previous.y === point.y) {
    return;
  }

  points.push(point);
};

const measureOccupiedBounds = (
  nodes: GraphLayoutNode[],
  edges: GraphLayoutEdge[]
): { maxX: number; maxY: number } => {
  let maxX = 0;
  let maxY = 0;

  for (const node of nodes) {
    maxX = Math.max(maxX, node.x + CARD.width);
    maxY = Math.max(maxY, node.y + node.cardHeight);
  }

  for (const edge of edges) {
    for (const point of edge.routePoints) {
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }

  return { maxX, maxY };
};

const buildEdgeSvgPath = (
  routePoints: Array<{ x: number; y: number }>,
  fallbackStart: { x: number; y: number },
  fallbackEnd: { x: number; y: number }
): string => {
  const points = routePoints.length >= 2 ? routePoints : [fallbackStart, fallbackEnd];
  const firstPoint = points[0] ?? fallbackStart;
  const secondPoint = points[1] ?? fallbackEnd;
  if (points.length === 2) {
    return buildFallbackBezier(firstPoint, secondPoint);
  }

  let path = `M ${firstPoint.x} ${firstPoint.y}`;

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? firstPoint;
    const current = points[index] ?? previous;
    const next = points[index + 1] ?? secondPoint;
    const entry = trimPointTowards(current, previous, 18);
    const exit = trimPointTowards(current, next, 18);

    if (isNear(entry, current) || isNear(exit, current)) {
      path += ` L ${current.x} ${current.y}`;
      continue;
    }

    path += ` L ${entry.x} ${entry.y}`;
    path += ` Q ${current.x} ${current.y} ${exit.x} ${exit.y}`;
  }

  const lastPoint = points.at(-1) ?? fallbackEnd;
  path += ` L ${lastPoint.x} ${lastPoint.y}`;
  return path;
};

const buildFallbackBezier = (
  start: { x: number; y: number },
  end: { x: number; y: number }
): string => {
  const deltaX = Math.max(48, Math.abs(end.x - start.x) * 0.42);
  return [
    `M ${start.x} ${start.y}`,
    `C ${start.x + deltaX} ${start.y}, ${end.x - deltaX} ${end.y}, ${end.x} ${end.y}`
  ].join(" ");
};

const trimPointTowards = (
  anchor: { x: number; y: number },
  target: { x: number; y: number },
  radius: number
): { x: number; y: number } => {
  const dx = target.x - anchor.x;
  const dy = target.y - anchor.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    return anchor;
  }

  const offset = Math.min(radius, distance / 2);
  return {
    x: roundCoordinate(anchor.x + (dx / distance) * offset),
    y: roundCoordinate(anchor.y + (dy / distance) * offset)
  };
};

const isNear = (
  left: { x: number; y: number },
  right: { x: number; y: number }
): boolean => Math.abs(left.x - right.x) < 1 && Math.abs(left.y - right.y) < 1;

const roundCoordinate = (value: number): number => Math.round(value * 100) / 100;
