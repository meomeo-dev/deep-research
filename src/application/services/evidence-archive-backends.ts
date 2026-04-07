import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  AppError
} from "../../shared/errors";
import type {
  EvidenceArchiveBackend,
  EvidenceArchiveStatus
} from "../../domain/contracts";

export interface EvidenceArchiveBackendRequest {
  sourceUri: string;
  backend: EvidenceArchiveBackend;
  backendEndpoint?: string;
  sidecarManifestPath?: string;
  timeoutMs: number;
}

export interface EvidenceArchiveBackendResult {
  backend: EvidenceArchiveBackend;
  sourceUri: string;
  title: string;
  summary: string;
  body: string | null;
  failureReason: string | null;
  status: Exclude<EvidenceArchiveStatus, "none">;
}

interface Crawl4aiAdapterResponse {
  ok?: boolean;
  sourceUri?: unknown;
  title?: unknown;
  summary?: unknown;
  body?: unknown;
  failureReason?: unknown;
}

interface Crawl4aiSidecarManifest {
  endpoint?: unknown;
  socketPath?: unknown;
  token?: unknown;
  tokenFile?: unknown;
}

interface ResolvedCrawl4aiTransport {
  endpoint?: string;
  socketPath?: string;
  token: string | null;
}

interface ResolvedCrawl4aiManifest {
  endpoint?: string;
  socketPath?: string;
  token?: string;
  tokenFile?: string;
}

const buildSidecarRepairDetails = (manifestPath?: string): Record<string, unknown> => ({
  docsHint: "Run deep-research sidecar_setup for a managed runtime check before retrying crawl4ai archival.",
  manifestPath: manifestPath ?? null,
  repairCommands: [
    "deep-research sidecar_setup --project <project-root>",
    "deep-research sidecar_setup --project <project-root> --run-setup",
    "deep-research sidecar_setup --project <project-root> --run-doctor"
  ],
  repairHint: "Use the explicit sidecar setup flow to prepare or diagnose the Crawl4AI runtime."
});

const DEFAULT_SUMMARY_LIMIT = 280;
const DEFAULT_TITLE_FALLBACK = "Archived evidence";
const CRAWL4AI_ENDPOINT_ENV = "DEEP_RESEARCH_CRAWL4AI_ENDPOINT";
const CRAWL4AI_SOCKET_ENV = "DEEP_RESEARCH_CRAWL4AI_SOCKET";
const CRAWL4AI_TOKEN_ENV = "DEEP_RESEARCH_CRAWL4AI_TOKEN";
const CRAWL4AI_TOKEN_FILE_ENV = "DEEP_RESEARCH_CRAWL4AI_TOKEN_FILE";
const DEFAULT_CRAWL4AI_SOCKET_REQUEST_PATH = "/archive";

export const archiveEvidenceWithBackend = async (
  input: EvidenceArchiveBackendRequest
): Promise<EvidenceArchiveBackendResult> => {
  const sourceUri = normalizeSourceUri(input.sourceUri);
  const selectedBackend = input.backend;

  if (selectedBackend === "crawl4ai") {
    return archiveWithCrawl4ai({
      backendEndpoint: input.backendEndpoint,
      sidecarManifestPath: input.sidecarManifestPath,
      sourceUri,
      timeoutMs: input.timeoutMs
    });
  }

  return archiveWithNode({
    sourceUri,
    timeoutMs: input.timeoutMs
  });
};

const normalizeSourceUri = (value: string): string => {
  try {
    return new URL(value).toString();
  } catch {
    throw new AppError("INVALID_SOURCE_URI", `Invalid source URI: ${value}`, 2, { sourceUri: value });
  }
};

const archiveWithNode = async (input: {
  sourceUri: string;
  timeoutMs: number;
}): Promise<EvidenceArchiveBackendResult> => {
  let response: Response;
  try {
    response = await fetchWithFailureDetails(input.sourceUri, input.timeoutMs, "node");
  } catch (error) {
    return buildDegradedResult({
      backend: "node",
      failureReason: error instanceof AppError ? error.message : "FETCH_REQUEST_FAILED: unknown error",
      sourceUri: input.sourceUri
    });
  }

  if (!response.ok) {
    return buildDegradedResult({
      backend: "node",
      failureReason: `FETCH_HTTP_${response.status}: ${response.statusText || "upstream returned a non-success status"}`,
      sourceUri: response.url || input.sourceUri
    });
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const rawBody = await response.text();
  const resolvedSourceUri = response.url || input.sourceUri;

  if (contentType.includes("text/html")) {
    const extracted = extractHtmlArchive(rawBody, resolvedSourceUri);
    if (!extracted.body) {
      return buildDegradedResult({
        backend: "node",
        failureReason: "EXTRACTION_EMPTY: no readable text extracted",
        sourceUri: resolvedSourceUri,
        title: extracted.title
      });
    }

    return {
      backend: "node",
      body: extracted.body,
      failureReason: null,
      sourceUri: resolvedSourceUri,
      status: "archived",
      summary: extracted.summary,
      title: extracted.title
    };
  }

  if (contentType.includes("text/plain") || contentType.includes("application/json")) {
    const normalizedBody = normalizeWhitespace(rawBody);
    if (!normalizedBody) {
      return buildDegradedResult({
        backend: "node",
        failureReason: "EXTRACTION_EMPTY: upstream response body was empty",
        sourceUri: resolvedSourceUri
      });
    }

    return {
      backend: "node",
      body: normalizedBody,
      failureReason: null,
      sourceUri: resolvedSourceUri,
      status: "archived",
      summary: buildSummary(normalizedBody),
      title: buildFallbackTitle(resolvedSourceUri)
    };
  }

  return buildDegradedResult({
    backend: "node",
    failureReason: `UNSUPPORTED_CONTENT_TYPE: ${contentType || "unknown"}`,
    sourceUri: resolvedSourceUri
  });
};

const archiveWithCrawl4ai = async (input: {
  backendEndpoint?: string;
  sidecarManifestPath?: string;
  sourceUri: string;
  timeoutMs: number;
}): Promise<EvidenceArchiveBackendResult> => {
  let transport: ResolvedCrawl4aiTransport;
  try {
    transport = resolveCrawl4aiTransport({
      explicitEndpoint: input.backendEndpoint,
      sidecarManifestPath: input.sidecarManifestPath
    });
  } catch (error) {
    return buildDegradedResult({
      backend: "crawl4ai",
      failureReason:
        error instanceof AppError
          ? error.message
          : "ADAPTER_REQUEST_FAILED: unknown error",
      sourceUri: input.sourceUri
    });
  }

  let response: AdapterHttpResponse;
  try {
    response = await postArchiveRequestToCrawl4ai({
      payload: {
        sourceUrl: input.sourceUri,
        timeoutMs: input.timeoutMs
      },
      timeoutMs: input.timeoutMs,
      transport
    });
  } catch (error) {
    return buildDegradedResult({
      backend: "crawl4ai",
      failureReason:
        error instanceof AppError
          ? error.message
          : "ADAPTER_REQUEST_FAILED: unknown error",
      sourceUri: input.sourceUri
    });
  }

  if (!response.ok) {
    return buildDegradedResult({
      backend: "crawl4ai",
      failureReason: `ADAPTER_HTTP_${response.status}: ${response.statusText || "archive adapter returned a non-success status"}`,
      sourceUri: input.sourceUri
    });
  }

  let payload: Crawl4aiAdapterResponse;
  try {
    payload = JSON.parse(response.body) as Crawl4aiAdapterResponse;
  } catch {
    return buildDegradedResult({
      backend: "crawl4ai",
      failureReason: "ADAPTER_INVALID_JSON: archive adapter returned an invalid JSON payload",
      sourceUri: input.sourceUri
    });
  }

  const resolvedSourceUri =
    typeof payload.sourceUri === "string" && payload.sourceUri.length > 0
      ? payload.sourceUri
      : input.sourceUri;
  const title =
    typeof payload.title === "string" && payload.title.trim().length > 0
      ? payload.title.trim()
      : buildFallbackTitle(resolvedSourceUri);
  const summary =
    typeof payload.summary === "string" && payload.summary.trim().length > 0
      ? payload.summary.trim()
      : buildSummary(typeof payload.body === "string" ? payload.body : "");
  const body =
    typeof payload.body === "string" && normalizeWhitespace(payload.body).length > 0
      ? normalizeWhitespace(payload.body)
      : "";
  const failureReason =
    typeof payload.failureReason === "string" && payload.failureReason.trim().length > 0
      ? payload.failureReason.trim()
      : null;

  if (payload.ok === false || body.length === 0) {
    return buildDegradedResult({
      backend: "crawl4ai",
      failureReason: failureReason ?? "ADAPTER_EMPTY_BODY: archive adapter did not return a readable body",
      sourceUri: resolvedSourceUri,
      title
    });
  }

  return {
    backend: "crawl4ai",
    body,
    failureReason: null,
    sourceUri: resolvedSourceUri,
    status: "archived",
    summary,
    title
  };
};

interface AdapterHttpResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

const resolveCrawl4aiTransport = (input: {
  explicitEndpoint?: string;
  sidecarManifestPath?: string;
}): ResolvedCrawl4aiTransport => {
  const explicitEndpoint = input.explicitEndpoint?.trim();
  if (explicitEndpoint) {
    return {
      endpoint: normalizeEndpoint(explicitEndpoint),
      token: resolveCrawl4aiToken({ required: false })
    };
  }

  const endpointFromEnv = process.env[CRAWL4AI_ENDPOINT_ENV]?.trim();
  if (endpointFromEnv) {
    return {
      endpoint: normalizeEndpoint(endpointFromEnv),
      token: resolveCrawl4aiToken({ required: false })
    };
  }

  const socketFromEnv = process.env[CRAWL4AI_SOCKET_ENV]?.trim();
  if (socketFromEnv) {
    return {
      socketPath: socketFromEnv,
      token: resolveCrawl4aiToken({ required: true })
    };
  }

  const manifest = readCrawl4aiManifest(input.sidecarManifestPath);
  if (manifest?.socketPath) {
    return {
      socketPath: manifest.socketPath,
      token: resolveCrawl4aiToken({
        inlineToken: manifest.token,
        required: true,
        tokenFile: manifest.tokenFile
      })
    };
  }

  if (manifest?.endpoint) {
    return {
      endpoint: normalizeEndpoint(manifest.endpoint),
      token: resolveCrawl4aiToken({
        inlineToken: manifest.token,
        required: false,
        tokenFile: manifest.tokenFile
      })
    };
  }

  throw new AppError(
    "CRAWL4AI_SIDECAR_UNAVAILABLE",
    "CRAWL4AI_SIDECAR_UNAVAILABLE: no secure sidecar locator was found. Start a managed sidecar or provide an explicit fallback endpoint.",
    2,
    {
      ...buildSidecarRepairDetails(input.sidecarManifestPath),
      endpointEnv: CRAWL4AI_ENDPOINT_ENV,
      manifestPath: input.sidecarManifestPath ?? null,
      socketEnv: CRAWL4AI_SOCKET_ENV,
      tokenEnv: CRAWL4AI_TOKEN_ENV,
      tokenFileEnv: CRAWL4AI_TOKEN_FILE_ENV
    }
  );
};

const postArchiveRequestToCrawl4ai = async (input: {
  payload: { sourceUrl: string; timeoutMs: number };
  timeoutMs: number;
  transport: ResolvedCrawl4aiTransport;
}): Promise<AdapterHttpResponse> => {
  const payloadText = JSON.stringify(input.payload);
  if (input.transport.endpoint) {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (input.transport.token) {
      headers.authorization = `Bearer ${input.transport.token}`;
    }
    const response = await fetchWithFailureDetails(
      input.transport.endpoint,
      input.timeoutMs,
      "crawl4ai",
      {
        body: payloadText,
        headers,
        method: "POST"
      }
    );

    return {
      body: await response.text(),
      ok: response.ok,
      status: response.status,
      statusText: response.statusText
    };
  }

  if (!input.transport.socketPath || !input.transport.token) {
    throw new AppError(
      "CRAWL4AI_TRANSPORT_INVALID",
      "CRAWL4AI_TRANSPORT_INVALID: secure socket transport requires both a socket path and a bearer token.",
      2,
      buildSidecarRepairDetails()
    );
  }

  return postArchiveRequestOverSocket({
    body: payloadText,
    socketPath: input.transport.socketPath,
    timeoutMs: input.timeoutMs,
    token: input.transport.token
  });
};

const postArchiveRequestOverSocket = (input: {
  body: string;
  socketPath: string;
  timeoutMs: number;
  token: string;
}): Promise<AdapterHttpResponse> =>
  new Promise((resolve, reject) => {
    const request = http.request(
      {
        headers: {
          authorization: `Bearer ${input.token}`,
          "content-length": Buffer.byteLength(input.body).toString(),
          "content-type": "application/json"
        },
        method: "POST",
        path: DEFAULT_CRAWL4AI_SOCKET_REQUEST_PATH,
        socketPath: input.socketPath
      },
      (response) => {
        const chunks: string[] = [];
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          chunks.push(chunk);
        });
        response.on("end", () => {
          resolve({
            body: chunks.join(""),
            ok: (response.statusCode ?? 500) >= 200 && (response.statusCode ?? 500) < 300,
            status: response.statusCode ?? 500,
            statusText: response.statusMessage || ""
          });
        });
      }
    );

    request.setTimeout(input.timeoutMs, () => {
      request.destroy(new Error("FETCH_TIMEOUT: upstream request timed out"));
    });
    request.on("error", (error) => {
      reject(degradedResponseFromError(input.socketPath, "crawl4ai", error));
    });
    request.write(input.body);
    request.end();
  });

const readCrawl4aiManifest = (manifestPath?: string): ResolvedCrawl4aiManifest | null => {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Crawl4aiSidecarManifest;
    return {
      endpoint: typeof parsed.endpoint === "string" && parsed.endpoint.trim().length > 0
        ? parsed.endpoint.trim()
        : undefined,
      socketPath: typeof parsed.socketPath === "string" && parsed.socketPath.trim().length > 0
        ? parsed.socketPath.trim()
        : undefined,
      token: typeof parsed.token === "string" && parsed.token.trim().length > 0
        ? parsed.token.trim()
        : undefined,
      tokenFile:
        typeof parsed.tokenFile === "string" && parsed.tokenFile.trim().length > 0
          ? resolveTokenFilePath(pathFromManifest(manifestPath, parsed.tokenFile.trim()))
          : undefined
    };
  } catch {
    throw new AppError(
      "CRAWL4AI_MANIFEST_INVALID",
      `CRAWL4AI_MANIFEST_INVALID: failed to parse sidecar manifest at ${manifestPath}.`,
      2,
      { manifestPath }
    );
  }
};

const pathFromManifest = (manifestPath: string, candidatePath: string): string => {
  if (path.isAbsolute(candidatePath)) {
    return candidatePath;
  }
  return path.resolve(path.dirname(manifestPath), candidatePath);
};

const resolveTokenFilePath = (candidatePath?: string): string | undefined =>
  candidatePath?.trim() || process.env[CRAWL4AI_TOKEN_FILE_ENV]?.trim() || undefined;

const resolveCrawl4aiToken = (input: {
  inlineToken?: string;
  tokenFile?: string;
  required: boolean;
}): string | null => {
  const inlineToken = input.inlineToken?.trim() || process.env[CRAWL4AI_TOKEN_ENV]?.trim() || "";
  if (inlineToken.length > 0) {
    return inlineToken;
  }

  const tokenFilePath = resolveTokenFilePath(input.tokenFile);
  if (tokenFilePath && fs.existsSync(tokenFilePath)) {
    const fileToken = fs.readFileSync(tokenFilePath, "utf8").trim();
    if (fileToken.length > 0) {
      return fileToken;
    }
  }

  if (input.required) {
    throw new AppError(
      "CRAWL4AI_TOKEN_MISSING",
      "CRAWL4AI_TOKEN_MISSING: secure Crawl4AI sidecar transport requires a bearer token.",
      2,
      {
        ...buildSidecarRepairDetails(),
        tokenEnv: CRAWL4AI_TOKEN_ENV,
        tokenFileEnv: CRAWL4AI_TOKEN_FILE_ENV
      }
    );
  }

  return null;
};

const normalizeEndpoint = (value: string): string => {
  try {
    return new URL(value).toString();
  } catch {
    throw new AppError(
      "INVALID_BACKEND_ENDPOINT",
      `Invalid backend endpoint: ${value}`,
      2,
      { backendEndpoint: value }
    );
  }
};

const fetchWithFailureDetails = async (
  input: string,
  timeoutMs: number,
  backend: EvidenceArchiveBackend,
  init?: Parameters<typeof fetch>[1]
): Promise<Response> => {
  try {
    return await fetch(input, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    return degradedResponseFromError(input, backend, error);
  }
};

const degradedResponseFromError = (
  sourceUri: string,
  backend: EvidenceArchiveBackend,
  error: unknown
): never => {
  const reason =
    error instanceof Error && error.name === "TimeoutError"
      ? "FETCH_TIMEOUT: upstream request timed out"
      : error instanceof Error
        ? `${backend === "crawl4ai" ? "ADAPTER_REQUEST_FAILED" : "FETCH_REQUEST_FAILED"}: ${error.message}`
        : `${backend === "crawl4ai" ? "ADAPTER_REQUEST_FAILED" : "FETCH_REQUEST_FAILED"}: unknown error`;

  throw new AppError("ARCHIVE_BACKEND_REQUEST_FAILED", reason, 2, {
    backend,
    sourceUri
  });
};

const extractHtmlArchive = (
  rawHtml: string,
  sourceUri: string
): {
  title: string;
  summary: string;
  body: string;
} => {
  const titleMatch = rawHtml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = titleMatch?.[1] ? decodeHtmlEntities(titleMatch[1]) : "";
  const strippedText = normalizeWhitespace(
    decodeHtmlEntities(
      rawHtml
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
  );

  return {
    body: strippedText,
    summary: buildSummary(strippedText),
    title: rawTitle.trim() || buildFallbackTitle(sourceUri)
  };
};

const buildDegradedResult = (input: {
  backend: EvidenceArchiveBackend;
  failureReason: string;
  sourceUri: string;
  title?: string;
}): EvidenceArchiveBackendResult => ({
  backend: input.backend,
  body: null,
  failureReason: input.failureReason,
  sourceUri: input.sourceUri,
  status: "degraded",
  summary: `Archive degraded: ${input.failureReason}`,
  title: input.title ?? buildFallbackTitle(input.sourceUri)
});

const buildFallbackTitle = (sourceUri: string): string => {
  try {
    const parsed = new URL(sourceUri);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return pathname ? `${parsed.host}${pathname}` : parsed.host || DEFAULT_TITLE_FALLBACK;
  } catch {
    return sourceUri || DEFAULT_TITLE_FALLBACK;
  }
};

const buildSummary = (value: string): string => {
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    return "";
  }
  return normalized.length > DEFAULT_SUMMARY_LIMIT
    ? `${normalized.slice(0, DEFAULT_SUMMARY_LIMIT - 1)}...`
    : normalized;
};

const decodeHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();
