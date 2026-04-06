import { describe, expect, it } from "vitest";
import {
  buildGraphSvgDocument,
  computeGraphLayout,
  type GraphLayoutEdge,
  type GraphLayoutNode
} from "../../src/cli/graph-rendering";

const RIGHT_PADDING = 120;
const BOTTOM_PADDING = 84;
const SVG_TOP_OFFSET = 24;
const VISIBLE_BOTTOM_BREATHING_ROOM = 60;

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
});
