import { describe, expect, it } from "vitest";
import {
  GRAPH_FONT_FAMILY,
  buildGraphSvgDocument,
  computeGraphLayout,
  measureSvgTextWidth,
  wrapSvgText,
  type GraphLayoutEdge,
  type GraphLayoutNode
} from "../../src/cli/graph-rendering";

const RIGHT_PADDING = 120;
const BOTTOM_PADDING = 84;
const SVG_TOP_OFFSET = 24;
const VISIBLE_BOTTOM_BREATHING_ROOM = 60;
const CARD_CONTENT_WIDTH = 216 - 32;
const FONT_FAMILY = GRAPH_FONT_FAMILY;

const measureOccupiedBounds = (
  nodes: GraphLayoutNode[],
  edges: GraphLayoutEdge[]
): { maxX: number; maxY: number } => {
  let maxX = 0;
  let maxY = 0;

  for (const node of nodes) {
    maxX = Math.max(maxX, node.x + 216);
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

describe("graph rendering layout bounds", () => {
  it("uses a CJK-capable font stack for mixed-language node text", () => {
    expect(GRAPH_FONT_FAMILY).toContain("PingFang SC");
    expect(GRAPH_FONT_FAMILY).toContain("Noto Sans CJK SC");
    expect(GRAPH_FONT_FAMILY.indexOf("Hiragino Sans GB")).toBeLessThan(
      GRAPH_FONT_FAMILY.indexOf("Avenir Next")
    );

    const titleLines = wrapSvgText("OpenAI GPT 策略演化路径", {
      fontFamily: FONT_FAMILY,
      fontSize: 14,
      fontWeight: 700,
      maxLines: 2,
      maxWidth: CARD_CONTENT_WIDTH
    });

    expect(titleLines[0]).toContain("OpenAI GPT");
    expect(titleLines.join("")).toContain("策略演化路径");
  });

  it("splits mixed-script SVG text into explicit font-family runs", async () => {
    const nodes = [
      {
        body: "English mixed text 与 中文 body 一起出现。",
        epistemicState: "untested" as const,
        id: "node-mixed",
        kind: "evidence" as const,
        title: "Mixed Title / 混合标题",
        workflowState: "draft" as const
      }
    ];

    const { edges, layoutNodes, viewport } = await computeGraphLayout(nodes, [], {});
    const svg = buildGraphSvgDocument({
      branchName: "mixed-script-runs",
      edges,
      height: viewport.height,
      nodes: layoutNodes,
      width: viewport.width
    });

    expect(svg).toContain("font-family=\"'Avenir Next'");
    expect(svg).toContain("font-family=\"'Hiragino Sans GB'");
    expect(svg).toContain("English mixed text");
    expect(svg).toContain(">与</tspan>");
    expect(svg).toContain(">中文</tspan>");
    expect(svg).toContain("body ");
    expect(svg).toContain("一起出现");
  });

  it.skip("documents the historical leading-symbol font-family fallback state before neutral resolution", async () => {
    const nodes = [
      {
        body: "• English title",
        epistemicState: "untested" as const,
        id: "node-symbol-english",
        kind: "evidence" as const,
        title: "→ Mixed 混排 title",
        workflowState: "draft" as const
      },
      {
        body: "【标记】English 与 中文",
        epistemicState: "supported" as const,
        id: "node-symbol-cjk",
        kind: "finding" as const,
        title: "- 中文标题",
        workflowState: "ready" as const
      }
    ];

    const { edges, layoutNodes, viewport } = await computeGraphLayout(nodes, [], {});
    const svg = buildGraphSvgDocument({
      branchName: "leading-symbol-font-state",
      edges,
      height: viewport.height,
      nodes: layoutNodes,
      width: viewport.width
    });

    expect(svg).toMatch(
      /<tspan[^>]*font-family="'Hiragino Sans GB'[^"]*"[^>]*>• <\/tspan>/
    );
    expect(svg).toMatch(
      /<tspan[^>]*font-family="'Hiragino Sans GB'[^"]*"[^>]*>→ <\/tspan>/
    );
    expect(svg).toMatch(
      /<tspan[^>]*font-family="'Avenir Next'[^"]*"[^>]*>- <\/tspan>/
    );
    expect(svg).toContain("Mixed ");
    expect(svg).toContain("中文标题");
    expect(svg).toContain("【标记】");
  });

  it("assigns leading neutral symbols to the following strong script without collapsing CJK-boundary tspans", async () => {
    const nodes = [
      {
        body: "• English title",
        epistemicState: "untested" as const,
        id: "node-neutral-english",
        kind: "evidence" as const,
        title: "→ Mixed 混排 title",
        workflowState: "draft" as const
      },
      {
        body: "【标记】English 与 中文",
        epistemicState: "supported" as const,
        id: "node-neutral-cjk",
        kind: "finding" as const,
        title: "- 中文标题",
        workflowState: "ready" as const
      }
    ];

    const { edges, layoutNodes, viewport } = await computeGraphLayout(nodes, [], {});
    const svg = buildGraphSvgDocument({
      branchName: "leading-neutral-target-behavior",
      edges,
      height: viewport.height,
      nodes: layoutNodes,
      width: viewport.width
    });

    expect(svg).toMatch(
      /<tspan[^>]*font-family="'Avenir Next'[^"]*"[^>]*>• English title<\/tspan>/
    );
    expect(svg).toMatch(
      /<tspan[^>]*font-family="'Avenir Next'[^"]*"[^>]*>→ Mixed <\/tspan>/
    );
    expect(svg).toMatch(
      /<tspan[^>]*font-family="'Hiragino Sans GB'[^"]*"[^>]*>- <\/tspan>\s*<tspan[^>]*font-family="'Hiragino Sans GB'[^"]*"[^>]*>中文标题<\/tspan>/
    );
  });

  it.each([
    "- 中文标题",
    "• 中文标题",
    "→ 中文标题"
  ])("keeps leading neutral CJK runs split for %s", async (text) => {
    const nodes = [
      {
        body: "Neutral split probe",
        epistemicState: "supported" as const,
        id: `node-leading-neutral-${text.length}`,
        kind: "finding" as const,
        title: text,
        workflowState: "resolved" as const
      }
    ];

    const { edges, layoutNodes, viewport } = await computeGraphLayout(nodes, [], {});
    const svg = buildGraphSvgDocument({
      branchName: "leading-neutral-cjk-split",
      edges,
      height: viewport.height,
      nodes: layoutNodes,
      width: viewport.width
    });

    expect(svg).toMatch(
      /<tspan[^>]*font-family="'Hiragino Sans GB'[^"]*"[^>]*>[^\u4e00-\u9fff]*<\/tspan>\s*<tspan[^>]*font-family="'Hiragino Sans GB'[^"]*"[^>]*>中文标题<\/tspan>/
    );
  });

  it.each([
    {
      expectedPattern: /<tspan[^>]*font-family="'Avenir Next'[^"]*"[^>]*>English • <\/tspan>/,
      label: "inherits the previous Latin run for inline neutral punctuation",
      text: "English • 中文"
    },
    {
      expectedPattern:
        /<tspan[^>]*font-family="'Hiragino Sans GB'[^"]*"[^>]*>中文<\/tspan>\s*<tspan[^>]*font-family="'Hiragino Sans GB'[^"]*"[^>]*> → <\/tspan>/,
      label: "inherits the previous CJK run for inline neutral punctuation while preserving a safe boundary",
      text: "中文 → English"
    },
    {
      expectedPattern:
        /<tspan[^>]*font-family="'Avenir Next'[^"]*"[^>]*>•<\/tspan>\s*<tspan[^>]*font-family="'Avenir Next'[^"]*"[^>]*> <\/tspan>\s*<tspan[^>]*font-family="'Avenir Next'[^"]*"[^>]*>→<\/tspan>\s*<tspan[^>]*font-family="'Avenir Next'[^"]*"[^>]*> <\/tspan>\s*<tspan[^>]*font-family="'Avenir Next'[^"]*"[^>]*>-<\/tspan>/,
      label: "falls back to Latin when a line contains only neutral symbols while keeping symbols in safe standalone runs",
      text: "• → -"
    }
  ])("$label", async ({ expectedPattern, text }) => {
    const nodes = [
      {
        body: text,
        epistemicState: "untested" as const,
        id: `node-${text.length}`,
        kind: "evidence" as const,
        title: "Neutral precedence probe",
        workflowState: "draft" as const
      }
    ];

    const { edges, layoutNodes, viewport } = await computeGraphLayout(nodes, [], {});
    const svg = buildGraphSvgDocument({
      branchName: "neutral-precedence-probe",
      edges,
      height: viewport.height,
      nodes: layoutNodes,
      width: viewport.width
    });

    expect(svg).toMatch(expectedPattern);
  });

  it("wraps and truncates long CJK text within the card line budget", () => {
    const titleLines = wrapSvgText(
      "中文节点标题需要在导出图片时稳定换行并在超出两行限制后自动省略尾部信息",
      {
        fontFamily: FONT_FAMILY,
        fontSize: 14,
        fontWeight: 700,
        maxLines: 2,
        maxWidth: CARD_CONTENT_WIDTH
      }
    );
    const bodyLines = wrapSvgText(
      "中文正文用于验证节点正文在真实导出场景里不会越过卡片边界并且会按照既定的五行预算进行稳定换行如果内容仍然继续增长则最后一行必须自动追加省略号避免文字直接跑出节点外框同时保留主要语义供排查使用",
      {
        fontFamily: FONT_FAMILY,
        fontSize: 12,
        fontWeight: 400,
        maxLines: 5,
        maxWidth: CARD_CONTENT_WIDTH
      }
    );

    expect(titleLines).toHaveLength(2);
    expect(titleLines[1]?.endsWith("…")).toBe(true);
    for (const line of titleLines) {
      expect(
        measureSvgTextWidth(line, {
          fontFamily: FONT_FAMILY,
          fontSize: 14,
          fontWeight: 700
        })
      ).toBeLessThanOrEqual(CARD_CONTENT_WIDTH);
    }

    expect(bodyLines).toHaveLength(5);
    expect(bodyLines[4]?.endsWith("…")).toBe(true);
    for (const line of bodyLines) {
      expect(
        measureSvgTextWidth(line, {
          fontFamily: FONT_FAMILY,
          fontSize: 12,
          fontWeight: 400
        })
      ).toBeLessThanOrEqual(CARD_CONTENT_WIDTH);
    }
  });

  it("keeps right and bottom slack within the shared layout budget", async () => {
    const nodes = [
      {
        body: "Quantify whether deeper prompting is worth the extra cost.",
        epistemicState: "untested" as const,
        id: "node-root",
        kind: "question" as const,
        title: "Prompt depth tradeoff",
        workflowState: "active" as const
      },
      {
        body: "Multi-step prompting tends to help when decomposition matters.",
        epistemicState: "supported" as const,
        id: "node-left",
        kind: "finding" as const,
        title: "Decomposition helps",
        workflowState: "resolved" as const
      },
      {
        body: "Token overhead can erase gains on easy tasks.",
        epistemicState: "untested" as const,
        id: "node-right",
        kind: "hypothesis" as const,
        title: "Cost can dominate",
        workflowState: "ready" as const
      },
      {
        body: "Cross-check on a second benchmark before closing the claim.",
        epistemicState: "untested" as const,
        id: "node-tail",
        kind: "task" as const,
        title: "Validate on another dataset",
        workflowState: "active" as const
      }
    ];
    const edges = [
      {
        fromNodeId: "node-root",
        id: "edge-root-left",
        kind: "supports" as const,
        toNodeId: "node-left"
      },
      {
        fromNodeId: "node-root",
        id: "edge-root-right",
        kind: "supports" as const,
        toNodeId: "node-right"
      },
      {
        fromNodeId: "node-left",
        id: "edge-left-tail",
        kind: "depends_on" as const,
        toNodeId: "node-tail"
      },
      {
        fromNodeId: "node-right",
        id: "edge-right-tail",
        kind: "depends_on" as const,
        toNodeId: "node-tail"
      }
    ];

    const { edges: layoutEdges, layoutNodes, viewport } = await computeGraphLayout(nodes, edges, {});
    const occupiedBounds = measureOccupiedBounds(layoutNodes, layoutEdges);
    const rightSlack = viewport.width - occupiedBounds.maxX;
    const rawBottomSlack = viewport.height - occupiedBounds.maxY;
    const visibleBottomSlack = viewport.height - (occupiedBounds.maxY + SVG_TOP_OFFSET);

    expect(rightSlack).toBeGreaterThanOrEqual(0);
    expect(rawBottomSlack).toBeGreaterThanOrEqual(0);
    expect(rightSlack).toBeCloseTo(RIGHT_PADDING, 5);
    expect(rawBottomSlack).toBeCloseTo(BOTTOM_PADDING, 5);
    expect(visibleBottomSlack).toBeCloseTo(VISIBLE_BOTTOM_BREATHING_ROOM, 5);

    const svg = buildGraphSvgDocument({
      branchName: "layout-bounds-regression",
      edges: layoutEdges,
      height: viewport.height,
      nodes: layoutNodes,
      width: viewport.width
    });

    expect(svg).toContain(`viewBox="0 0 ${viewport.width} ${viewport.height}"`);
    expect(svg).toContain(`transform="translate(0 ${SVG_TOP_OFFSET})"`);
  });

  it("preserves logical viewBox when PNG render size is scaled up", async () => {
    const nodes = [
      {
        body: "Keep logical and pixel spaces separate during raster export.",
        epistemicState: "untested" as const,
        id: "node-a",
        kind: "question" as const,
        title: "Separate SVG spaces",
        workflowState: "active" as const
      },
      {
        body: "A scaled PNG should raise output resolution, not enlarge the SVG world.",
        epistemicState: "supported" as const,
        id: "node-b",
        kind: "finding" as const,
        title: "Scale must stay in render space",
        workflowState: "resolved" as const
      }
    ];
    const edges = [
      {
        fromNodeId: "node-a",
        id: "edge-a-b",
        kind: "supports" as const,
        toNodeId: "node-b"
      }
    ];

    const { edges: layoutEdges, layoutNodes, viewport } = await computeGraphLayout(nodes, edges, {});
    const renderedWidth = Math.round(viewport.width * 1.45);
    const renderedHeight = Math.round(viewport.height * 1.45);
    const svg = buildGraphSvgDocument({
      branchName: "scaled-render-regression",
      edges: layoutEdges,
      height: viewport.height,
      nodes: layoutNodes,
      renderedHeight,
      renderedWidth,
      width: viewport.width
    });

    expect(svg).toContain(`width="${renderedWidth}" height="${renderedHeight}"`);
    expect(svg).toContain(`viewBox="0 0 ${viewport.width} ${viewport.height}"`);
  });

  it("renders explicit arrowheads instead of relying on SVG markers", async () => {
    const nodes = [
      {
        body: "Root node for arrowhead rendering.",
        epistemicState: "supported" as const,
        id: "node-source",
        kind: "finding" as const,
        title: "Arrow source",
        workflowState: "resolved" as const
      },
      {
        body: "Target node for arrowhead rendering.",
        epistemicState: "supported" as const,
        id: "node-target",
        kind: "conclusion" as const,
        title: "Arrow target",
        workflowState: "resolved" as const
      }
    ];
    const edges = [
      {
        fromNodeId: "node-source",
        id: "edge-source-target",
        kind: "supports" as const,
        toNodeId: "node-target"
      }
    ];

    const { edges: layoutEdges, layoutNodes, viewport } = await computeGraphLayout(nodes, edges, {});
    const svg = buildGraphSvgDocument({
      branchName: "arrowhead-render-regression",
      edges: layoutEdges,
      height: viewport.height,
      nodes: layoutNodes,
      width: viewport.width
    });

    expect(svg).not.toContain("marker-end=");
    expect(svg).toContain('fill="rgba(100, 116, 139, 0.72)"');
  });
});
