import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const rootDir = process.cwd();
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "deep-research-clean-install-")
);
const projectCopyDir = path.join(tempRoot, "workspace");

const excludedNames = new Set([
  ".git",
  ".deep-research",
  ".todo_tasks",
  "dist",
  "node_modules",
  "tmp"
]);

const copyProject = () => {
  fs.cpSync(rootDir, projectCopyDir, {
    recursive: true,
    filter: (sourcePath) => {
      const baseName = path.basename(sourcePath);
      return !excludedNames.has(baseName);
    }
  });
};

const runStep = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: projectCopyDir,
    env: process.env,
    stdio: "inherit"
  });

  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
};

const cleanup = () => {
  fs.rmSync(tempRoot, { force: true, recursive: true });
};

globalThis.console.error(`[release-verify] creating temp project copy at ${projectCopyDir}`);

try {
  copyProject();
  globalThis.console.error("[release-verify] running pnpm install --frozen-lockfile");
  runStep(packageManager, ["install", "--frozen-lockfile"]);
  globalThis.console.error("[release-verify] running pnpm run test:release-surface");
  runStep(packageManager, ["run", "test:release-surface"]);
  globalThis.console.error("[release-verify] clean-install release surface passed");
} finally {
  cleanup();
}
