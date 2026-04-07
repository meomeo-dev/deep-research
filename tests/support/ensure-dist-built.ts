import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const distCliEntry = path.join(process.cwd(), "dist", "cli", "main.js");
const packageManager = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const buildLockDir = path.join(os.tmpdir(), "deep-research-dist-build.lock");
const buildStampFile = path.join(os.tmpdir(), "deep-research-dist-build.stamp");
const waitBuffer = new SharedArrayBuffer(4);
const waitView = new Int32Array(waitBuffer);

const sleep = (milliseconds: number): void => {
  Atomics.wait(waitView, 0, 0, milliseconds);
};

const distIsReady = (): boolean => fs.existsSync(distCliEntry);

const waitForOtherBuilder = (): void => {
  const timeoutAt = Date.now() + 120000;

  while (Date.now() < timeoutAt) {
    if (distIsReady()) {
      return;
    }

    if (!fs.existsSync(buildLockDir) && fs.existsSync(buildStampFile)) {
      return;
    }

    sleep(100);
  }

  throw new Error("Timed out while waiting for the shared dist build to finish.");
};

export const ensureDistBuilt = (): void => {
  if (distIsReady()) {
    return;
  }

  try {
    fs.mkdirSync(buildLockDir);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") {
      waitForOtherBuilder();
      return;
    }
    throw error;
  }

  try {
    if (!distIsReady()) {
      const buildResult = spawnSync(packageManager, ["build"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: process.env
      });

      if ((buildResult.status ?? 1) !== 0) {
        throw new Error(
          [
            `Shared dist build failed with exit code ${String(buildResult.status ?? 1)}.`,
            `STDOUT:\n${buildResult.stdout}`,
            `STDERR:\n${buildResult.stderr}`
          ].join("\n\n")
        );
      }
    }

    fs.writeFileSync(buildStampFile, new Date().toISOString(), "utf8");
  } finally {
    fs.rmSync(buildLockDir, { force: true, recursive: true });
  }
};
