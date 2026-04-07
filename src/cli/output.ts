import fs from "node:fs";
import type { ProjectPaths } from "../infrastructure/persistence/sqlite/db";
import { recordRecentRef } from "./recent-refs";

export type OutputFormat = "plain" | "json";
export type OutputMode = "auto" | "artifact" | "envelope";

export interface CommandEnvelope {
  ok: boolean;
  command: string;
  summary: string;
  context?: Record<string, unknown>;
  data: unknown;
}

export interface ErrorEnvelope {
  ok: false;
  command: string;
  summary: string;
  error: string;
  details?: unknown;
}

export interface OutputOptions {
  format: OutputFormat;
  output?: string;
  outputMode?: OutputMode;
  paths?: ProjectPaths;
}

export const writeSuccess = (
  command: string,
  data: unknown,
  options: OutputOptions
): void => {
  const payload = buildSuccessEnvelope(command, data);
  const sink = resolveOutputSink(command, payload, options);
  const text =
    options.format === "json"
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `${formatPlainEnvelope(payload)}\n`;

  if (options.paths) {
    persistRecentReference(command, data, options.paths);
  }

  if (options.output) {
    fs.writeFileSync(options.output, sink ?? text, "utf8");
  } else {
    process.stdout.write(text);
  }
};

export const writeError = (
  command: string,
  message: string,
  options: OutputOptions,
  details?: unknown
): void => {
  const payload: ErrorEnvelope = {
    command,
    details,
    error: message,
    ok: false,
    summary: `${command} failed: ${message}`
  };
  const text =
    options.format === "json"
      ? `${JSON.stringify(payload, null, 2)}\n`
      : `${formatPlainError(payload)}\n`;
  if (options.output) {
    fs.writeFileSync(options.output, text, "utf8");
  } else {
    process.stderr.write(text);
  }
};

const buildSuccessEnvelope = (command: string, data: unknown): CommandEnvelope => {
  const semantic = deriveSemanticContext(command, data);
  return {
    command,
    context: semantic.context,
    data,
    ok: true,
    summary: semantic.summary
  };
};

const deriveSemanticContext = (
  command: string,
  data: unknown
): {
  context?: Record<string, unknown>;
  summary: string;
} => {
  if (Array.isArray(data)) {
    return {
      context: {
        count: data.length,
        preview: data.slice(0, 3).map((item) => summarizeValue(item)),
        resultType: "collection"
      },
      summary: `${command} returned ${data.length} item(s).`
    };
  }

  if (isRecord(data)) {
    const context = summarizeValue(data);
    if (command === "graph_check") {
      const edges = typeof data.edges === "number" ? data.edges : undefined;
      const evidenceLinks = typeof data.evidenceLinks === "number" ? data.evidenceLinks : undefined;
      const graphOk = typeof data.ok === "boolean" ? data.ok : undefined;
      const nodes = typeof data.nodes === "number" ? data.nodes : undefined;
      return {
        context: {
          edges,
          evidenceLinks,
          nodes,
          ok: graphOk,
          resultType: "record"
        },
        summary: `${command} confirmed ok=${String(graphOk)} with ${String(nodes ?? 0)} node(s) and ${String(edges ?? 0)} edge(s).`
      };
    }

    if (command === "status") {
      const counts = isRecord(data.counts) ? data.counts : undefined;
      const research = isRecord(data.research) ? data.research : undefined;
      const branch = isRecord(data.branch) ? data.branch : undefined;
      const lifecycle = typeof research?.lifecycleState === "string" ? research.lifecycleState : "unknown";
      const branchName = typeof branch?.name === "string" ? branch.name : "unknown";
      const nodeCount = typeof counts?.nodes === "number" ? counts.nodes : 0;
      const evidenceCount = typeof counts?.evidence === "number" ? counts.evidence : 0;
      const artifactCount = typeof counts?.artifacts === "number" ? counts.artifacts : 0;
      const resolvedNodes = typeof counts?.resolvedNodes === "number" ? counts.resolvedNodes : 0;
      const verifiedEvidence = typeof counts?.verifiedEvidence === "number" ? counts.verifiedEvidence : 0;
      return {
        context: {
          artifacts: artifactCount,
          branchName,
          evidence: evidenceCount,
          lifecycle,
          nodes: nodeCount,
          resolvedNodes,
          verifiedEvidence,
          resultType: "record"
        },
        summary: `${command} shows ${lifecycle} lifecycle on branch ${branchName} with ${String(nodeCount)} node(s), ${String(resolvedNodes)} resolved node(s), ${String(evidenceCount)} evidence item(s), ${String(verifiedEvidence)} verified evidence item(s), and ${String(artifactCount)} artifact(s).`
      };
    }

    if (command === "doctor") {
      const sidecarRuntime = isRecord(data.sidecarRuntime) ? data.sidecarRuntime : undefined;
      const status = typeof sidecarRuntime?.status === "string" ? sidecarRuntime.status : "unknown";
      return {
        context: {
          dbPath: typeof data.dbPath === "string" ? data.dbPath : undefined,
          projectRoot: typeof data.projectRoot === "string" ? data.projectRoot : undefined,
          researchCount: typeof data.researchCount === "number" ? data.researchCount : undefined,
          resultType: "record",
          sidecarStatus: status
        },
        summary: `doctor reports sidecar runtime status=${status}.`
      };
    }

    if (command === "sidecar_setup") {
      const status = typeof data.status === "string"
        ? data.status
        : typeof data.inspection === "object" && data.inspection !== null && typeof (data.inspection as Record<string, unknown>).status === "string"
          ? String((data.inspection as Record<string, unknown>).status)
          : "unknown";
      const action = typeof data.action === "string" ? data.action : "inspect";
      return {
        context: {
          action,
          resultType: "record",
          status
        },
        summary:
          action === "inspect"
            ? `sidecar_setup inspected the managed Crawl4AI runtime and found status=${status}.`
            : `sidecar_setup ran ${action} for the managed Crawl4AI runtime.`
      };
    }

    if (command === "graph_visualize") {
      const htmlPath = typeof data.htmlPath === "string" ? data.htmlPath : "unknown";
      const nodes = typeof data.nodeCount === "number" ? data.nodeCount : 0;
      const edges = typeof data.edgeCount === "number" ? data.edgeCount : 0;
      return {
        context: {
          edgeCount: edges,
          htmlPath,
          nodeCount: nodes,
          openedInBrowser: Boolean(data.openedInBrowser),
          resultType: "record"
        },
        summary: `${command} generated ${htmlPath} with ${String(nodes)} node(s) and ${String(edges)} edge(s).`
      };
    }

    if (
      command === "graph_export" &&
      typeof data.pngPath === "string" &&
      typeof data.fileSize === "number"
    ) {
      const width = typeof data.width === "number" ? data.width : undefined;
      const height = typeof data.height === "number" ? data.height : undefined;
      return {
        context: {
          fileSize: data.fileSize,
          height,
          pngPath: data.pngPath,
          resultType: "record",
          width
        },
        summary: `${command} generated ${data.pngPath} (${String(data.fileSize)} bytes) at ${String(width ?? 0)}x${String(height ?? 0)}.`
      };
    }

    if (command === "export") {
      const artifactCount = typeof data.artifactCount === "number" ? data.artifactCount : undefined;
      const evidenceCount = typeof data.evidenceCount === "number" ? data.evidenceCount : undefined;
      if (artifactCount !== undefined || evidenceCount !== undefined) {
        return {
          context: {
            ...context,
            resultType: "record"
          },
          summary: `${command} prepared a readable report with ${String(artifactCount ?? 0)} artifact(s) and ${String(evidenceCount ?? 0)} evidence item(s).`
        };
      }
    }

    if (command === "artifact_export") {
      const artifactCount = typeof data.artifactCount === "number" ? data.artifactCount : undefined;
      if (artifactCount !== undefined) {
        return {
          context: {
            ...context,
            resultType: "record"
          },
          summary: `${command} prepared ${String(artifactCount)} artifact(s) for export.`
        };
      }
    }

    if (command === "evidence_archive" && isRecord(data)) {
      const evidence = isRecord(data.evidence) ? data.evidence : undefined;
      const archive = isRecord(data.archive) ? data.archive : undefined;
      const status = typeof archive?.status === "string" ? archive.status : "unknown";
      const backend = typeof archive?.backend === "string" ? archive.backend : undefined;
      const artifactId = typeof archive?.artifactId === "string" ? archive.artifactId : null;
      const failureReason = typeof archive?.failureReason === "string" ? archive.failureReason : null;
      return {
        context: {
          artifactId,
          backend,
          evidenceId: typeof evidence?.id === "string" ? evidence.id : undefined,
          failureReason,
          resultType: "record",
          status
        },
        summary:
          status === "archived"
            ? `${command} persisted citation metadata and archived 1 webpage body.`
            : `${command} persisted citation metadata but archive degraded: ${failureReason ?? "unknown reason"}.`
      };
    }

    const primaryId = typeof data.id === "string" ? data.id : undefined;
    const title = typeof data.title === "string" ? data.title : undefined;
    const name = typeof data.name === "string" ? data.name : undefined;
    const identity = [title, name, primaryId].filter(Boolean).join(" | ");
    return {
      context: {
        ...context,
        resultType: "record"
      },
      summary: identity.length > 0
        ? `${command} returned 1 record: ${identity}.`
        : `${command} returned 1 record.`
    };
  }

  if (typeof data === "string") {
    return {
      context: {
        characterCount: data.length,
        resultType: "text"
      },
      summary: `${command} returned text output.`
    };
  }

  if (data == null) {
    return {
      summary: `${command} completed without data.`
    };
  }

  return {
    context: {
      resultType: typeof data
    },
    summary: `${command} completed successfully.`
  };
};

const summarizeValue = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    return { value };
  }

  const pickedEntries = Object.entries(value).filter(([key, fieldValue]) => {
    if (fieldValue == null) {
      return false;
    }
    return KNOWN_CONTEXT_KEYS.has(key);
  });

  if (pickedEntries.length === 0) {
    return {
      keys: Object.keys(value).slice(0, 8)
    };
  }

  return Object.fromEntries(pickedEntries);
};

const formatPlainEnvelope = (payload: CommandEnvelope): string => {
  const parts = [`Command: ${payload.command}`, `Summary: ${payload.summary}`];
  if (payload.context && Object.keys(payload.context).length > 0) {
    parts.push(`Context:\n${JSON.stringify(payload.context, null, 2)}`);
  }
  parts.push(`Data:\n${formatPlainData(payload.data)}`);
  return parts.join("\n\n");
};

const formatPlainError = (payload: ErrorEnvelope): string => {
  const parts = [`Command: ${payload.command}`, `Summary: ${payload.summary}`];
  if (payload.details !== undefined) {
    parts.push(`Details:\n${JSON.stringify(payload.details, null, 2)}`);
  }
  return parts.join("\n\n");
};

const formatPlainData = (data: unknown): string => {
  if (typeof data === "string") {
    return data;
  }
  return JSON.stringify(data, null, 2);
};

const resolveOutputSink = (
  command: string,
  payload: CommandEnvelope,
  options: OutputOptions
): string | undefined => {
  if (!options.output || options.format === "json") {
    return undefined;
  }

  const mode = options.outputMode ?? "auto";
  if (mode === "envelope") {
    return undefined;
  }

  const artifact = extractArtifactText(command, payload.data);
  if (!artifact) {
    return undefined;
  }

  if (mode === "artifact") {
    return artifact;
  }

  return ARTIFACT_COMMANDS.has(command) ? artifact : undefined;
};

const extractArtifactText = (command: string, data: unknown): string | undefined => {
  if (["export", "graph_export", "artifact_export"].includes(command) && typeof data === "string") {
    return data.endsWith("\n") ? data : `${data}\n`;
  }

  if (command === "graph_visualize" && isRecord(data) && typeof data.htmlPath === "string") {
    try {
      const html = fs.readFileSync(data.htmlPath, "utf8");
      return html.endsWith("\n") ? html : `${html}\n`;
    } catch {
      return undefined;
    }
  }

  return undefined;
};

const persistRecentReference = (
  command: string,
  data: unknown,
  paths: ProjectPaths
): void => {
  if (!isRecord(data)) {
    return;
  }

  if (command === "node_add" && typeof data.id === "string") {
    recordRecentRef(paths, "node", data.id);
    return;
  }

  if (command === "evidence_add" && typeof data.id === "string") {
    recordRecentRef(paths, "evidence", data.id);
    return;
  }

  if (
    command === "evidence_archive" &&
    isRecord(data.evidence) &&
    typeof data.evidence.id === "string"
  ) {
    recordRecentRef(paths, "evidence", data.evidence.id);
    return;
  }

  if (command === "branch_create" && typeof data.name === "string") {
    recordRecentRef(paths, "branch", data.name);
    return;
  }

  if (command === "artifact_add" && typeof data.id === "string") {
    recordRecentRef(paths, "artifact", data.id);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const ARTIFACT_COMMANDS = new Set([
  "artifact_export",
  "export",
  "graph_export",
  "graph_visualize"
]);

const KNOWN_CONTEXT_KEYS = new Set([
  "artifactKind",
  "artifactId",
  "branchId",
  "branchState",
  "createdAt",
  "action",
  "failureReason",
  "currentBranchId",
  "dbPath",
  "edges",
  "epistemicState",
  "evidenceId",
  "exists",
  "forkedFromVersionId",
  "headVersionId",
  "id",
  "kind",
  "backend",
  "lifecycleState",
  "maturityState",
  "name",
  "nodeId",
  "nodes",
  "ok",
  "parentBranchId",
  "projectRoot",
  "publishedAt",
  "question",
  "reason",
  "relation",
  "researchId",
  "repairHint",
  "status",
  "sourceUri",
  "summary",
  "title",
  "trustLevel",
  "updatedAt",
  "verifiedAt",
  "versionId",
  "versionNumber",
  "workflowState"
]);