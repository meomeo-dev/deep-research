import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AppError } from "../../shared/errors";
import { resolvePackageRoot } from "../../shared/package-root";

const CRAWL4AI_ENDPOINT_ENV = "DEEP_RESEARCH_CRAWL4AI_ENDPOINT";
const CRAWL4AI_SOCKET_ENV = "DEEP_RESEARCH_CRAWL4AI_SOCKET";
const CRAWL4AI_TOKEN_ENV = "DEEP_RESEARCH_CRAWL4AI_TOKEN";
const CRAWL4AI_SERVICE_SCRIPT_ENV = "DEEP_RESEARCH_CRAWL4AI_SERVICE_SCRIPT";
const CRAWL4AI_PYTHON_ENV = "DEEP_RESEARCH_CRAWL4AI_PYTHON";
const CRAWL4AI_RUNTIME_ROOT_ENV = "DEEP_RESEARCH_CRAWL4AI_RUNTIME_ROOT";
const CRAWL4AI_MANIFEST_PATH_ENV = "DEEP_RESEARCH_CRAWL4AI_MANIFEST_PATH";
const CRAWL4AI_STARTUP_TIMEOUT_ENV = "DEEP_RESEARCH_CRAWL4AI_STARTUP_TIMEOUT_MS";
const CRAWL4AI_SETUP_COMMAND_ENV = "DEEP_RESEARCH_CRAWL4AI_SETUP_COMMAND";
const CRAWL4AI_DOCTOR_COMMAND_ENV = "DEEP_RESEARCH_CRAWL4AI_DOCTOR_COMMAND";
const DEFAULT_RUNTIME_DIR_NAME = "dr-c4a";
const DEFAULT_MANAGED_VENV_DIR_NAME = "crawl4ai-venv";
const DEFAULT_SOCKET_NAME = "crawl4ai.sock";
const DEFAULT_READY_PATH = "/readyz";
const DEFAULT_STARTUP_TIMEOUT_MS = 20000;

export type ManagedCrawl4aiRuntimeStatus = "ready" | "needs_setup" | "misconfigured" | "external";

export interface ManagedCrawl4aiRuntimeInspection {
  status: ManagedCrawl4aiRuntimeStatus;
  managedVenvPath: string;
  pythonExecutable: string;
  requirementsPath: string;
  serviceScriptPath: string;
  setupCommand: string;
  doctorCommand: string;
  endpointConfigured: boolean;
  socketConfigured: boolean;
  manifestPath: string;
  summary: string;
  repairHint: string | null;
  repairCommands: string[];
  checks: {
    crawl4aiImport: boolean;
    doctorCommand: boolean;
    pythonExecutable: boolean;
    requirementsFile: boolean;
    serviceScript: boolean;
    setupCommand: boolean;
  };
  diagnostics: {
    crawl4aiImportError: string | null;
    doctorCommandError: string | null;
    pythonExecutableError: string | null;
    setupCommandError: string | null;
  };
}

export interface ManagedCrawl4aiActionResult {
  action: "setup" | "doctor";
  command: string;
  exitCode: number;
  inspection: ManagedCrawl4aiRuntimeInspection;
  stderr: string;
  stdout: string;
}

interface ManagedSidecarHandle {
  child: ChildProcess;
  manifestPath: string;
  previousTokenEnv: string | undefined;
  runtimeDir: string;
  socketPath: string;
  stderrTail: string[];
  token: string;
}

export interface ManagedCrawl4aiSidecarOptions {
  manifestPath: string;
  projectRoot: string;
}

export class ManagedCrawl4aiSidecar {
  private handle: ManagedSidecarHandle | null = null;

  constructor(private readonly options: ManagedCrawl4aiSidecarOptions) {}

  shouldAutoStart(): boolean {
    const endpoint = process.env[CRAWL4AI_ENDPOINT_ENV]?.trim();
    const socket = process.env[CRAWL4AI_SOCKET_ENV]?.trim();

    if (endpoint || socket) {
      return false;
    }

    return !fs.existsSync(this.options.manifestPath);
  }

  async ensureReady(): Promise<void> {
    if (!this.shouldAutoStart()) {
      return;
    }

    if (this.handle) {
      return;
    }

    const inspection = inspectManagedCrawl4aiRuntime({
      manifestPath: this.options.manifestPath,
      projectRoot: this.options.projectRoot
    });
    if (inspection.status !== "ready") {
      throw runtimeNotReadyError(inspection);
    }

    const pythonExecutable = inspection.pythonExecutable;
    const serviceScript = inspection.serviceScriptPath;
    const runtimeDir = createRuntimeDir(this.options.projectRoot);
    const socketPath = path.join(runtimeDir, DEFAULT_SOCKET_NAME);
    const token = crypto.randomBytes(24).toString("hex");
    const stderrTail: string[] = [];
    const previousTokenEnv = process.env[CRAWL4AI_TOKEN_ENV];
    process.env[CRAWL4AI_TOKEN_ENV] = token;

    const child = spawn(pythonExecutable, [serviceScript], {
      env: {
        ...process.env,
        [CRAWL4AI_MANIFEST_PATH_ENV]: this.options.manifestPath,
        [CRAWL4AI_SOCKET_ENV]: socketPath,
        [CRAWL4AI_TOKEN_ENV]: token
      },
      stdio: ["ignore", "ignore", "pipe"]
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail.push(chunk.trim());
      while (stderrTail.length > 20) {
        stderrTail.shift();
      }
    });

    this.handle = {
      child,
      manifestPath: this.options.manifestPath,
      previousTokenEnv,
      runtimeDir,
      socketPath,
      stderrTail,
      token
    };

    try {
      await waitForSidecarReady({
        child,
        manifestPath: this.options.manifestPath,
        socketPath,
        stderrTail,
        timeoutMs: resolveStartupTimeoutMs(),
        token
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close(): void {
    if (!this.handle) {
      return;
    }

    const handle = this.handle;
    this.handle = null;
    terminateChild(handle.child, handle.stderrTail);
    cleanupManagedArtifacts(handle);
    restoreTokenEnv(handle.previousTokenEnv);
  }
}

export const inspectManagedCrawl4aiRuntime = (input: {
  manifestPath: string;
  projectRoot: string;
}): ManagedCrawl4aiRuntimeInspection => {
  const managedVenvPath = resolveManagedVenvPath(input.projectRoot);
  const pythonExecutable = resolvePythonExecutable(input.projectRoot);
  const serviceScriptPath = resolveServiceScriptPath();
  const requirementsPath = resolveRequirementsPath();
  const setupCommand = resolveUtilityCommandPath(pythonExecutable, "crawl4ai-setup", CRAWL4AI_SETUP_COMMAND_ENV);
  const doctorCommand = resolveUtilityCommandPath(pythonExecutable, "crawl4ai-doctor", CRAWL4AI_DOCTOR_COMMAND_ENV);
  const endpointConfigured = Boolean(process.env[CRAWL4AI_ENDPOINT_ENV]?.trim());
  const socketConfigured = Boolean(process.env[CRAWL4AI_SOCKET_ENV]?.trim());
  const pythonProbe = probeProcess(pythonExecutable, ["--version"]);
  const importProbe = pythonProbe.ok
    ? probeProcess(pythonExecutable, ["-c", "import crawl4ai"], false)
    : failedProbe(pythonProbe.error ?? "python executable unavailable");
  const setupProbe = probeCommandAvailability(setupCommand);
  const doctorProbe = probeCommandAvailability(doctorCommand);
  const checks = {
    crawl4aiImport: importProbe.ok,
    doctorCommand: doctorProbe.ok,
    pythonExecutable: pythonProbe.ok,
    requirementsFile: fs.existsSync(requirementsPath),
    serviceScript: fs.existsSync(serviceScriptPath),
    setupCommand: setupProbe.ok
  };
  const diagnostics = {
    crawl4aiImportError: importProbe.error,
    doctorCommandError: doctorProbe.error,
    pythonExecutableError: pythonProbe.error,
    setupCommandError: setupProbe.error
  };

  if (endpointConfigured || socketConfigured) {
    return {
      checks,
      diagnostics,
      doctorCommand,
      endpointConfigured,
      manifestPath: input.manifestPath,
      managedVenvPath,
      pythonExecutable,
      repairCommands: [],
      repairHint: null,
      requirementsPath,
      serviceScriptPath,
      setupCommand,
      socketConfigured,
      status: "external",
      summary: "External Crawl4AI transport is configured; managed runtime setup is not required for this command path."
    };
  }

  const repairCommands = buildRepairCommands({
    projectRoot: input.projectRoot
  });

  if (!checks.pythonExecutable || !checks.requirementsFile || !checks.serviceScript) {
    return {
      checks,
      diagnostics,
      doctorCommand,
      endpointConfigured,
      manifestPath: input.manifestPath,
      managedVenvPath,
      pythonExecutable,
      repairCommands,
      repairHint: "Fix the managed sidecar prerequisites or bootstrap Python before using crawl4ai.",
      requirementsPath,
      serviceScriptPath,
      setupCommand,
      socketConfigured,
      status: "misconfigured",
      summary: "Managed Crawl4AI runtime files are missing or unreadable."
    };
  }

  if (checks.crawl4aiImport && checks.setupCommand) {
    return {
      checks,
      diagnostics,
      doctorCommand,
      endpointConfigured,
      manifestPath: input.manifestPath,
      managedVenvPath,
      pythonExecutable,
      repairCommands: checks.doctorCommand
        ? [`deep-research sidecar_setup --project ${input.projectRoot} --run-doctor`]
        : [],
      repairHint: null,
      requirementsPath,
      serviceScriptPath,
      setupCommand,
      socketConfigured,
      status: "ready",
      summary: "Managed Crawl4AI runtime is ready."
    };
  }

  return {
    checks,
    diagnostics,
    doctorCommand,
    endpointConfigured,
    manifestPath: input.manifestPath,
    managedVenvPath,
    pythonExecutable,
    repairCommands,
    repairHint: "Run the explicit sidecar setup flow to create the shared Crawl4AI environment before using the managed backend.",
    requirementsPath,
    serviceScriptPath,
    setupCommand,
    socketConfigured,
    status: "needs_setup",
    summary: "Managed Crawl4AI runtime is not ready yet."
  };
};

export const runManagedCrawl4aiAction = (input: {
  action: "setup" | "doctor";
  manifestPath: string;
  projectRoot: string;
}): ManagedCrawl4aiActionResult => {
  const inspection = inspectManagedCrawl4aiRuntime({
    manifestPath: input.manifestPath,
    projectRoot: input.projectRoot
  });
  if (input.action === "setup" && shouldUseSharedManagedVenv()) {
    return runManagedProjectSetup(input.projectRoot, inspection);
  }

  const command = input.action === "setup" ? inspection.setupCommand : inspection.doctorCommand;
  const commandProbe = probeCommandAvailability(command);

  if (!commandProbe.ok) {
    throw new AppError(
      input.action === "setup" ? "CRAWL4AI_SETUP_COMMAND_MISSING" : "CRAWL4AI_DOCTOR_COMMAND_MISSING",
      input.action === "setup"
        ? "CRAWL4AI_SETUP_COMMAND_MISSING: crawl4ai-setup is not available in the shared managed Python environment."
        : "CRAWL4AI_DOCTOR_COMMAND_MISSING: crawl4ai-doctor is not available in the shared managed Python environment.",
      2,
      {
        command,
        projectRoot: input.projectRoot,
        repairCommands: buildRepairCommands({ projectRoot: input.projectRoot }),
        repairHint: "Run the shared sidecar setup first.",
        status: inspection.status
      }
    );
  }

  const result = spawnSync(command, [], {
    encoding: "utf8",
    env: process.env
  });

  const actionResult: ManagedCrawl4aiActionResult = {
    action: input.action,
    command,
    exitCode: result.status ?? 1,
    inspection,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? ""
  };

  if (result.error) {
    throw new AppError(
      input.action === "setup" ? "CRAWL4AI_SETUP_FAILED" : "CRAWL4AI_DOCTOR_FAILED",
      `${input.action === "setup" ? "CRAWL4AI_SETUP_FAILED" : "CRAWL4AI_DOCTOR_FAILED"}: ${result.error.message}`,
      2,
      {
        ...actionResult,
        repairCommands: buildRepairCommands({ projectRoot: input.projectRoot }),
        repairHint: "Review the command stderr and fix the Python/Crawl4AI environment before retrying."
      }
    );
  }

  if ((result.status ?? 1) !== 0) {
    throw new AppError(
      input.action === "setup" ? "CRAWL4AI_SETUP_FAILED" : "CRAWL4AI_DOCTOR_FAILED",
      `${input.action === "setup" ? "CRAWL4AI_SETUP_FAILED" : "CRAWL4AI_DOCTOR_FAILED"}: ${command} exited with code ${String(result.status ?? 1)}.`,
      2,
      {
        ...actionResult,
        repairCommands: buildRepairCommands({ projectRoot: input.projectRoot }),
        repairHint: "Review the command stderr and fix the reported Crawl4AI issues before retrying."
      }
    );
  }

  return actionResult;
};

const resolveStartupTimeoutMs = (): number => {
  const raw = process.env[CRAWL4AI_STARTUP_TIMEOUT_ENV]?.trim();
  if (!raw) {
    return DEFAULT_STARTUP_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_STARTUP_TIMEOUT_MS;
};

const resolveRequirementsPath = (): string => {
  const packageRoot = findPackageRoot(fileURLToPath(import.meta.url));
  return path.join(packageRoot, "resources", "sidecar", "requirements.txt");
};

const shouldUseSharedManagedVenv = (): boolean => {
  return !process.env[CRAWL4AI_PYTHON_ENV]?.trim();
};

const resolveManagedVenvPath = (projectRoot: string): string => {
  void projectRoot;
  const packageRoot = findPackageRoot(fileURLToPath(import.meta.url));
  return path.join(packageRoot, ".deep-research", DEFAULT_MANAGED_VENV_DIR_NAME);
};

const resolveManagedPythonExecutable = (projectRoot: string): string => {
  return path.join(
    resolveManagedVenvPath(projectRoot),
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python"
  );
};

const resolveBootstrapPythonExecutable = (): string => {
  const explicit = process.env[CRAWL4AI_PYTHON_ENV]?.trim();
  if (explicit) {
    return explicit;
  }

  return "python3";
};

const resolvePythonExecutable = (projectRoot: string): string => {
  const explicit = process.env[CRAWL4AI_PYTHON_ENV]?.trim();
  if (explicit) {
    return explicit;
  }

  return resolveManagedPythonExecutable(projectRoot);
};

const resolveServiceScriptPath = (): string => {
  const explicit = process.env[CRAWL4AI_SERVICE_SCRIPT_ENV]?.trim();
  if (explicit) {
    return explicit;
  }

  const packageRoot = findPackageRoot(fileURLToPath(import.meta.url));
  const scriptPath = path.join(packageRoot, "resources", "sidecar", "crawl4ai_service.py");
  if (!fs.existsSync(scriptPath)) {
    throw new AppError(
      "CRAWL4AI_SERVICE_SCRIPT_MISSING",
      `CRAWL4AI_SERVICE_SCRIPT_MISSING: expected sidecar service script at ${scriptPath}.`,
      2,
      { scriptPath }
    );
  }
  return scriptPath;
};

const resolveUtilityCommandPath = (
  pythonExecutable: string,
  commandName: string,
  overrideEnvName: string
): string => {
  const override = process.env[overrideEnvName]?.trim();
  if (override) {
    return override;
  }

  if (pythonExecutable.includes(path.sep)) {
    const candidate = path.join(path.dirname(pythonExecutable), commandName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return commandName;
};

const findPackageRoot = (modulePath: string): string => resolvePackageRoot(modulePath);

const createRuntimeDir = (projectRoot: string): string => {
  const runtimeBase = process.env[CRAWL4AI_RUNTIME_ROOT_ENV]?.trim() || path.join("/tmp", DEFAULT_RUNTIME_DIR_NAME);
  const projectHash = crypto.createHash("sha256").update(projectRoot).digest("hex").slice(0, 12);
  const uidPrefix = typeof process.getuid === "function" ? String(process.getuid()) : "nouid";
  fs.mkdirSync(runtimeBase, { mode: 0o700, recursive: true });
  const runtimeDir = fs.mkdtempSync(path.join(runtimeBase, `${uidPrefix}-${projectHash}-`));
  return runtimeDir;
};

const waitForSidecarReady = async (input: {
  child: ChildProcess;
  manifestPath: string;
  socketPath: string;
  stderrTail: string[];
  timeoutMs: number;
  token: string;
}): Promise<void> => {
  const deadline = Date.now() + input.timeoutMs;

  while (Date.now() < deadline) {
    if (input.child.exitCode !== null) {
      throw sidecarStartError(
        `CRAWL4AI_SIDECAR_EXITED: managed sidecar exited during startup with code ${String(input.child.exitCode)}.`,
        input.stderrTail,
        input.socketPath
      );
    }

    if (input.child.signalCode !== null) {
      throw sidecarStartError(
        `CRAWL4AI_SIDECAR_EXITED: managed sidecar exited during startup with signal ${String(input.child.signalCode)}.`,
        input.stderrTail,
        input.socketPath
      );
    }

    try {
      const response = await requestSidecar({
        pathName: DEFAULT_READY_PATH,
        socketPath: input.socketPath,
        token: input.token
      });
      if (response.status === 200 && fs.existsSync(input.manifestPath)) {
        return;
      }
      if (response.status === 503) {
        const failureReason = extractFailureReason(response.body);
        if (failureReason) {
          throw sidecarStartError(failureReason, input.stderrTail, input.socketPath);
        }
      }
    } catch (error) {
      if (Date.now() >= deadline) {
        throw sidecarStartError(
          error instanceof Error ? error.message : "CRAWL4AI_SIDECAR_STARTUP_FAILED",
          input.stderrTail,
          input.socketPath
        );
      }
    }

    await sleep(100);
  }

  throw sidecarStartError(
    `CRAWL4AI_SIDECAR_STARTUP_TIMEOUT: managed sidecar did not become ready within ${String(input.timeoutMs)}ms.`,
    input.stderrTail,
    input.socketPath
  );
};

const requestSidecar = (input: {
  pathName: string;
  socketPath: string;
  token: string;
}): Promise<{ body: string; status: number }> =>
  new Promise((resolve, reject) => {
    const request = http.request(
      {
        headers: {
          authorization: `Bearer ${input.token}`
        },
        method: "GET",
        path: input.pathName,
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
            status: response.statusCode ?? 500
          });
        });
      }
    );

    request.on("error", reject);
    request.end();
  });

const terminateChild = (child: ChildProcess, stderrTail: string[]): void => {
  void stderrTail;
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }

  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      return;
    }
  }
};

const cleanupManagedArtifacts = (handle: ManagedSidecarHandle): void => {
  removeManagedManifest(handle.manifestPath, handle.child.pid ?? null, handle.socketPath);
  fs.rmSync(handle.runtimeDir, { force: true, recursive: true });
};

const removeManagedManifest = (
  manifestPath: string,
  pid: number | null,
  socketPath: string
): void => {
  if (!fs.existsSync(manifestPath)) {
    return;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      pid?: unknown;
      socketPath?: unknown;
    };
    if (
      (typeof parsed.pid === "number" && pid !== null && parsed.pid !== pid) ||
      (typeof parsed.socketPath === "string" && parsed.socketPath !== socketPath)
    ) {
      return;
    }
  } catch {
    return;
  }

  fs.rmSync(manifestPath, { force: true });
};

const restoreTokenEnv = (previousValue: string | undefined): void => {
  if (previousValue === undefined) {
    delete process.env[CRAWL4AI_TOKEN_ENV];
    return;
  }
  process.env[CRAWL4AI_TOKEN_ENV] = previousValue;
};

const buildRepairCommands = (input: {
  projectRoot: string;
}): string[] => [
  `deep-research sidecar_setup --project ${input.projectRoot}`,
  `deep-research sidecar_setup --project ${input.projectRoot} --run-setup`,
  `deep-research sidecar_setup --project ${input.projectRoot} --run-doctor`
];

const runManagedProjectSetup = (
  projectRoot: string,
  inspection: ManagedCrawl4aiRuntimeInspection
): ManagedCrawl4aiActionResult => {
  const managedVenvPath = resolveManagedVenvPath(projectRoot);
  const bootstrapPython = resolveBootstrapPythonExecutable();
  const createVenvResult = ensureManagedVenvExists(bootstrapPython, managedVenvPath);
  const managedPython = resolveManagedPythonExecutable(projectRoot);
  const pipInstallResult = spawnSync(
    managedPython,
    ["-m", "pip", "install", "-r", inspection.requirementsPath],
    {
      encoding: "utf8",
      env: process.env
    }
  );

  if (pipInstallResult.error || (pipInstallResult.status ?? 1) !== 0) {
    throw new AppError(
      "CRAWL4AI_SETUP_FAILED",
      `CRAWL4AI_SETUP_FAILED: failed to install managed sidecar requirements into ${managedVenvPath}.`,
      2,
      {
        bootstrapPython,
        command: `${managedPython} -m pip install -r ${inspection.requirementsPath}`,
        exitCode: pipInstallResult.status ?? 1,
        managedVenvPath,
        repairCommands: buildRepairCommands({ projectRoot }),
        repairHint: "The shared Crawl4AI venv could not be prepared. Review pip stderr and retry setup.",
        stderr: `${createVenvResult.stderr}${pipInstallResult.stderr ?? ""}`,
        stdout: `${createVenvResult.stdout}${pipInstallResult.stdout ?? ""}`
      }
    );
  }

  const setupCommand = resolveUtilityCommandPath(managedPython, "crawl4ai-setup", CRAWL4AI_SETUP_COMMAND_ENV);
  const setupResult = spawnSync(setupCommand, [], {
    encoding: "utf8",
    env: process.env
  });

  const actionResult: ManagedCrawl4aiActionResult = {
    action: "setup",
    command: `${managedPython} -m pip install -r ${inspection.requirementsPath} && ${setupCommand}`,
    exitCode: setupResult.status ?? 1,
    inspection: inspectManagedCrawl4aiRuntime({
      manifestPath: inspection.manifestPath,
      projectRoot
    }),
    stderr: `${createVenvResult.stderr}${pipInstallResult.stderr ?? ""}${setupResult.stderr ?? ""}`,
    stdout: `${createVenvResult.stdout}${pipInstallResult.stdout ?? ""}${setupResult.stdout ?? ""}`
  };

  if (setupResult.error || (setupResult.status ?? 1) !== 0) {
    throw new AppError(
      "CRAWL4AI_SETUP_FAILED",
      `CRAWL4AI_SETUP_FAILED: ${setupCommand} exited with code ${String(setupResult.status ?? 1)}.`,
      2,
      {
        ...actionResult,
        managedVenvPath,
        repairCommands: buildRepairCommands({ projectRoot }),
        repairHint: "The shared Crawl4AI venv was created, but crawl4ai-setup failed. Review stderr and retry."
      }
    );
  }

  return actionResult;
};

const ensureManagedVenvExists = (
  bootstrapPython: string,
  managedVenvPath: string
): { stderr: string; stdout: string } => {
  const managedPython = path.join(
    managedVenvPath,
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python"
  );
  if (fs.existsSync(managedPython)) {
    return { stderr: "", stdout: "" };
  }

  fs.mkdirSync(path.dirname(managedVenvPath), { recursive: true });
  const createVenvResult = spawnSync(bootstrapPython, ["-m", "venv", managedVenvPath], {
    encoding: "utf8",
    env: process.env
  });

  if (createVenvResult.error || (createVenvResult.status ?? 1) !== 0 || !fs.existsSync(managedPython)) {
    throw new AppError(
      "CRAWL4AI_SETUP_FAILED",
      `CRAWL4AI_SETUP_FAILED: failed to create the shared managed venv at ${managedVenvPath}.`,
      2,
      {
        bootstrapPython,
        command: `${bootstrapPython} -m venv ${managedVenvPath}`,
        exitCode: createVenvResult.status ?? 1,
        managedVenvPath,
        repairHint: "A bootstrap Python with venv support is required to create the shared Crawl4AI environment.",
        stderr: createVenvResult.stderr ?? "",
        stdout: createVenvResult.stdout ?? ""
      }
    );
  }

  return {
    stderr: createVenvResult.stderr ?? "",
    stdout: createVenvResult.stdout ?? ""
  };
};

const probeCommandAvailability = (command: string): { error: string | null; ok: boolean } => {
  const resolvedPath = resolveExecutablePath(command);
  if (!resolvedPath) {
    return failedProbe(`command not found: ${command}`);
  }
  return { error: null, ok: true };
};

const resolveExecutablePath = (command: string): string | null => {
  if (!command.trim()) {
    return null;
  }

  if (command.includes(path.sep)) {
    return isExecutablePath(command) ? command : null;
  }

  const pathEntries = (process.env.PATH || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    if (isExecutablePath(candidate)) {
      return candidate;
    }
  }

  return null;
};

const isExecutablePath = (candidatePath: string): boolean => {
  try {
    fs.accessSync(candidatePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const probeProcess = (
  command: string,
  args: string[],
  allowNonZeroExit = true
): { error: string | null; ok: boolean } => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env
  });
  if (result.error) {
    return failedProbe(result.error.message);
  }
  if (!allowNonZeroExit && (result.status ?? 1) !== 0) {
    return failedProbe((result.stderr || result.stdout || `exit code ${(result.status ?? 1).toString()}`).trim());
  }
  return { error: null, ok: (result.status ?? 1) === 0 || allowNonZeroExit };
};

const failedProbe = (error: string): { error: string; ok: false } => ({
  error,
  ok: false
});

const runtimeNotReadyError = (
  inspection: ManagedCrawl4aiRuntimeInspection
): AppError =>
  new AppError(
    "CRAWL4AI_RUNTIME_NOT_READY",
    `CRAWL4AI_RUNTIME_NOT_READY: ${inspection.summary}`,
    2,
    {
      diagnostics: inspection.diagnostics,
      pythonExecutable: inspection.pythonExecutable,
      repairCommands: inspection.repairCommands,
      repairHint: inspection.repairHint,
      requirementsPath: inspection.requirementsPath,
      status: inspection.status,
      summary: inspection.summary
    }
  );

const extractFailureReason = (body: string): string | null => {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; failureReason?: unknown };
    if (typeof parsed.failureReason === "string" && parsed.failureReason.trim().length > 0) {
      return parsed.failureReason.trim();
    }
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error.trim();
    }
  } catch {
    return null;
  }
  return null;
};

const sidecarStartError = (
  message: string,
  stderrTail: string[],
  socketPath: string | null
): AppError =>
  new AppError(
    "CRAWL4AI_SIDECAR_START_FAILED",
    message,
    2,
    {
      socketPath,
      stderrTail: stderrTail.filter((entry) => entry.length > 0).slice(-10)
    }
  );

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
};
