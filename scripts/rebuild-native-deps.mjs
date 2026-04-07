import process from "node:process";
import { spawnSync } from "node:child_process";

const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const steps = [
  {
    command: pnpmCommand,
    args: ["rebuild", "better-sqlite3", "esbuild"],
    label: "pnpm rebuild better-sqlite3 esbuild"
  },
  {
    command: npmCommand,
    args: ["rebuild", "better-sqlite3"],
    label: "npm rebuild better-sqlite3"
  }
];

for (const step of steps) {
  globalThis.console.error(`[native-rebuild] running ${step.label}`);
  const result = spawnSync(step.command, step.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit"
  });

  if ((result.status ?? 1) !== 0) {
    throw new Error(`${step.label} failed with exit code ${result.status ?? 1}`);
  }
}

globalThis.console.error("[native-rebuild] native dependency rebuild completed");
