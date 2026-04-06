import { AppError } from "../shared/errors";
import type { EdgeView } from "./contracts";

export const assertAcyclic = (edges: EdgeView[]): void => {
  const adjacency = new Map<string, string[]>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const edge of edges) {
    const next = adjacency.get(edge.fromNodeId) ?? [];
    next.push(edge.toNodeId);
    adjacency.set(edge.fromNodeId, next);
  }

  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      throw new AppError(
        "DAG_CYCLE",
        `Detected a cycle at node ${nodeId}.`,
        2,
        { cycleNodeId: nodeId }
      );
    }
    if (visited.has(nodeId)) {
      return;
    }
    visiting.add(nodeId);
    for (const target of adjacency.get(nodeId) ?? []) {
      visit(target);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };

  for (const nodeId of adjacency.keys()) {
    visit(nodeId);
  }
};