import fs from "node:fs";
import type { ProjectPaths } from "../infrastructure/persistence/sqlite/db";

export type RecentRefKind = "artifact" | "branch" | "evidence" | "node";

interface RecentRefsState {
  artifact?: string;
  branch?: string;
  evidence?: string;
  node?: string;
  updatedAt?: string;
}

const TOKEN_MAP: Record<string, RecentRefKind> = {
  "@last-artifact": "artifact",
  "@last-branch": "branch",
  "@last-evidence": "evidence",
  "@last-node": "node"
};

export const resolveRecentRef = (
  paths: ProjectPaths,
  value: string | undefined,
  expectedKind: RecentRefKind
): string | undefined => {
  if (!value) {
    return value;
  }

  const normalized = value.trim();
  if (TOKEN_MAP[normalized] !== expectedKind) {
    return value;
  }

  const state = readRecentRefs(paths);
  const resolved = state[expectedKind];
  if (!resolved) {
    throw new Error(`No recent ${expectedKind} reference is available for ${normalized}.`);
  }
  return resolved;
};

export const recordRecentRef = (
  paths: ProjectPaths,
  kind: RecentRefKind,
  value: string
): void => {
  const state = readRecentRefs(paths);
  state[kind] = value;
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(paths.recentRefsPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
};

export const readRecentRefs = (paths: ProjectPaths): RecentRefsState => {
  if (!fs.existsSync(paths.recentRefsPath)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(paths.recentRefsPath, "utf8");
    const parsed = JSON.parse(raw) as RecentRefsState;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
};
