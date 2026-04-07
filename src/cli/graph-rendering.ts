import ELK from "elkjs/lib/elk.bundled.js";
import path from "node:path";
import { Canvas } from "skia-canvas";
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
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  maxLines: number;
  maxWidth: number;
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

const ELLIPSIS = "…";
const EDGE_STROKE = "rgba(100, 116, 139, 0.54)";
const EDGE_ARROW_FILL = "rgba(100, 116, 139, 0.72)";
const EDGE_ARROW_LENGTH = 12;
const EDGE_ARROW_HALF_WIDTH = 4;
const WIDE_CHAR_RANGES = [
  [0x1100, 0x11ff],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7af],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe6f],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd]
] as const;
// Critical: do not delete or simplify this font stack comment or the font list below.
// Mixed Chinese/English titles can render as "???" in PNG export if Latin-first fonts win fallback.
// Keep CJK-capable fonts ahead of Latin UI fonts so SVG text measurement and skia-canvas raster export
// both pick glyphs that can render mixed-script node titles reliably across common macOS/Windows setups.
export const GRAPH_FONT_FAMILY_NAMES = [
  "Hiragino Sans GB",
  "PingFang SC",
  "Noto Sans CJK SC",
  "Source Han Sans SC",
  "Microsoft YaHei",
  "Arial Unicode MS",
  "Apple Symbols",
  "Segoe UI",
  "Avenir Next",
  "Helvetica Neue",
  "Arial",
  "sans-serif"
] as const;
export const GRAPH_FONT_FAMILY = GRAPH_FONT_FAMILY_NAMES.map((name) =>
  name.includes(" ") ? `'${name}'` : name
).join(", ");
const GRAPH_CJK_FONT_FAMILY = [
  "Hiragino Sans GB",
  "PingFang SC",
  "Noto Sans CJK SC",
  "Source Han Sans SC",
  "Microsoft YaHei",
  "Arial Unicode MS",
  "Apple Symbols",
  "sans-serif"
]
  .map((name) => (name.includes(" ") ? `'${name}'` : name))
  .join(", ");
const GRAPH_LATIN_FONT_FAMILY = [
  "Avenir Next",
  "Helvetica Neue",
  "Segoe UI",
  "Arial",
  "Arial Unicode MS",
  "Apple Symbols",
  "sans-serif"
]
  .map((name) => (name.includes(" ") ? `'${name}'` : name))
  .join(", ");
const TEXT_MEASURE_CANVAS = new Canvas(1, 1);
const TEXT_MEASURE_CONTEXT = TEXT_MEASURE_CANVAS.getContext("2d");
const TEXT_WIDTH_CACHE = new Map<string, number>();

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
    "  </defs>",
    `  <rect width="${viewWidth}" height="${viewHeight}" fill="url(#paper)" />`,
    `  <text x="32" y="42" font-family="${GRAPH_FONT_FAMILY}" font-size="16" font-weight="700" fill="#1e293b">${escapeHtml(input.branchName)}</text>`,
    `  <text x="32" y="66" font-family="${GRAPH_FONT_FAMILY}" font-size="12" fill="#6b7280">Nodes: ${input.nodes.length} · Edges: ${input.edges.length}</text>`,
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
  const arrowHeadPath = buildArrowHeadPath(edge);
  return [
    "",
    `    <path d="${edge.svgPath}" fill="none" stroke="${EDGE_STROKE}" stroke-width="2.5" />`,
    `    <path d="${arrowHeadPath}" fill="${EDGE_ARROW_FILL}" stroke="none" />`
  ].join("\n");
};

const buildArrowHeadPath = (edge: GraphLayoutEdge): string => {
  const tip = edge.routePoints.at(-1) ?? { x: edge.toX, y: edge.toY };
  const base = findArrowBasePoint(edge.routePoints, tip) ?? { x: edge.fromX, y: edge.fromY };
  const deltaX = tip.x - base.x;
  const deltaY = tip.y - base.y;
  const vectorLength = Math.hypot(deltaX, deltaY) || 1;
  const unitX = deltaX / vectorLength;
  const unitY = deltaY / vectorLength;
  const normalX = -unitY;
  const normalY = unitX;
  const rearX = tip.x - unitX * EDGE_ARROW_LENGTH;
  const rearY = tip.y - unitY * EDGE_ARROW_LENGTH;
  const leftX = rearX + normalX * EDGE_ARROW_HALF_WIDTH;
  const leftY = rearY + normalY * EDGE_ARROW_HALF_WIDTH;
  const rightX = rearX - normalX * EDGE_ARROW_HALF_WIDTH;
  const rightY = rearY - normalY * EDGE_ARROW_HALF_WIDTH;

  return `M ${formatSvgNumber(tip.x)} ${formatSvgNumber(tip.y)} L ${formatSvgNumber(leftX)} ${formatSvgNumber(leftY)} L ${formatSvgNumber(rightX)} ${formatSvgNumber(rightY)} Z`;
};

const findArrowBasePoint = (
  routePoints: Array<{ x: number; y: number }>,
  tip: { x: number; y: number }
): { x: number; y: number } | undefined => {
  for (let index = routePoints.length - 2; index >= 0; index -= 1) {
    const candidate = routePoints[index];
    if (!candidate) {
      continue;
    }

    if (candidate.x !== tip.x || candidate.y !== tip.y) {
      return candidate;
    }
  }

  return undefined;
};

const formatSvgNumber = (value: number): string => value.toFixed(2);

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
      fontFamily: GRAPH_FONT_FAMILY,
      fontSize: 11,
      fontWeight: 500,
      maxLines: CARD.metaMaxLines,
      maxWidth: CARD.width - CARD.paddingX * 2
    }
  );
  const titleLines = wrapSvgText(node.title, {
    fontFamily: GRAPH_FONT_FAMILY,
    fontSize: 14,
    fontWeight: 700,
    maxLines: CARD.titleMaxLines,
    maxWidth: CARD.width - CARD.paddingX * 2
  });
  const bodyLines = wrapSvgText(node.body || "No body text.", {
    fontFamily: GRAPH_FONT_FAMILY,
    fontSize: 12,
    fontWeight: 400,
    maxLines: CARD.bodyMaxLines,
    maxWidth: CARD.width - CARD.paddingX * 2
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
  if (!uppercase) {
    return lines
      .map((line, index) =>
        renderMixedScriptLine(line, {
          fill,
          fontSize,
          fontWeight,
          lineHeight,
          x,
          y: y + index * lineHeight
        })
      )
      .join("\n");
  }

  const attributes = uppercase ? ' text-transform="uppercase" letter-spacing="0.04em"' : "";
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeHtml(line)}</tspan>`
    )
    .join("");
  return `      <text x="${x}" y="${y}" font-family="${GRAPH_FONT_FAMILY}" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}"${attributes}>${tspans}</text>`;
};

const renderMixedScriptLine = (
  line: string,
  options: {
    fill: string;
    fontSize: number;
    fontWeight: number;
    lineHeight: number;
    x: number;
    y: number;
  }
): string => {
  const segments = segmentTextByScript(line);
  if (segments.length === 0) {
    return `      <text x="${options.x}" y="${options.y}" font-family="${GRAPH_CJK_FONT_FAMILY}" font-size="${options.fontSize}" font-weight="${options.fontWeight}" fill="${options.fill}"></text>`;
  }

  let cursorX = options.x;
  const tspans = segments
    .map((segment) => {
      const fontFamily = segment.script === "latin" ? GRAPH_LATIN_FONT_FAMILY : GRAPH_CJK_FONT_FAMILY;
      const tspan = `        <tspan x="${formatSvgNumber(cursorX)}" y="${formatSvgNumber(options.y)}" font-family="${fontFamily}">${escapeHtml(segment.text)}</tspan>`;
      cursorX += measureSvgTextWidth(segment.text, {
        fontFamily,
        fontSize: options.fontSize,
        fontWeight: options.fontWeight
      });
      return tspan;
    })
    .join("\n");

  return [
    `      <text x="${options.x}" y="${options.y}" font-size="${options.fontSize}" font-weight="${options.fontWeight}" fill="${options.fill}">`,
    tspans,
    "      </text>"
  ].join("\n");
};

const segmentTextByScript = (
  text: string
): Array<{ script: "cjk" | "latin"; text: string }> => {
  const segments: Array<{ script: "cjk" | "latin"; text: string }> = [];

  for (const char of Array.from(text)) {
    const script = classifyTextScript(char, segments.at(-1)?.script);
    const previous = segments.at(-1);
    if (previous?.script === script) {
      previous.text += char;
      continue;
    }

    segments.push({ script, text: char });
  }

  return segments;
};

const classifyTextScript = (
  char: string,
  previousScript: "cjk" | "latin" | undefined
): "cjk" | "latin" => {
  if (isWideCharacter(char)) {
    return "cjk";
  }

  if (/^[A-Za-z0-9]$/.test(char)) {
    return "latin";
  }

  if (/^[\u0000-\u024f]$/.test(char)) {
    return previousScript ?? "latin";
  }

  return previousScript ?? "cjk";
};

export const wrapSvgText = (text: string, options: WrapTextOptions): string[] => {
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) {
    return [""];
  }

  const tokens = tokenizeSvgText(raw);
  const lines: string[] = [];
  let current = "";

  for (const token of tokens) {
    const parts = token === " " ? [token] : breakLongToken(token, options);
    for (const part of parts) {
      if (part === " " && (!current || current.endsWith(" "))) {
        continue;
      }

      const candidate = current ? `${current}${part}` : part;
      if (!current || measureSvgTextWidth(candidate, options) <= options.maxWidth) {
        current = candidate;
        continue;
      }

      lines.push(current.trimEnd());
      current = part === " " ? "" : part.trimStart();
    }
  }

  if (current) {
    lines.push(current.trimEnd());
  }

  if (lines.length <= options.maxLines) {
    return lines;
  }

  const visible = lines.slice(0, options.maxLines);
  const lastVisibleLine = visible[options.maxLines - 1] ?? "";
  visible[options.maxLines - 1] = clampLineWithEllipsis(
    lastVisibleLine,
    options
  );
  return visible;
};

const tokenizeSvgText = (text: string): string[] => {
  const tokens: string[] = [];
  let narrowToken = "";

  for (const char of Array.from(text)) {
    if (char === " ") {
      if (narrowToken) {
        tokens.push(narrowToken);
        narrowToken = "";
      }
      tokens.push(char);
      continue;
    }

    if (isWideCharacter(char)) {
      if (narrowToken) {
        tokens.push(narrowToken);
        narrowToken = "";
      }
      tokens.push(char);
      continue;
    }

    narrowToken += char;
  }

  if (narrowToken) {
    tokens.push(narrowToken);
  }

  return tokens;
};

const breakLongToken = (token: string, options: WrapTextOptions): string[] => {
  if (measureSvgTextWidth(token, options) <= options.maxWidth) {
    return [token];
  }

  const parts: string[] = [];
  let current = "";

  for (const char of Array.from(token)) {
    const candidate = `${current}${char}`;
    if (current && measureSvgTextWidth(candidate, options) > options.maxWidth) {
      parts.push(current);
      current = char;
      continue;
    }

    current = candidate;
  }

  if (current) {
    parts.push(current);
  }

  return parts;
};

const clampLineWithEllipsis = (line: string, options: WrapTextOptions): string => {
  if (options.maxWidth <= 0) {
    return ELLIPSIS;
  }

  let clamped = line.trimEnd();
  const ellipsisWidth = measureSvgTextWidth(ELLIPSIS, options);
  while (clamped && measureSvgTextWidth(clamped, options) + ellipsisWidth > options.maxWidth) {
    clamped = Array.from(clamped).slice(0, -1).join("");
  }

  return clamped ? `${clamped}${ELLIPSIS}` : ELLIPSIS;
};

export const measureSvgTextWidth = (
  text: string,
  options: Pick<WrapTextOptions, "fontFamily" | "fontSize" | "fontWeight">
): number => {
  const cacheKey = `${options.fontFamily}|${options.fontSize}|${options.fontWeight}|${text}`;
  const cached = TEXT_WIDTH_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  TEXT_MEASURE_CONTEXT.font = `${options.fontWeight} ${options.fontSize}px ${options.fontFamily}`;
  const width = TEXT_MEASURE_CONTEXT.measureText(text).width;
  TEXT_WIDTH_CACHE.set(cacheKey, width);
  return width;
};

const isWideCharacter = (char: string): boolean => {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) {
    return false;
  }

  return WIDE_CHAR_RANGES.some(
    ([start, end]) => codePoint >= start && codePoint <= end
  );
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
