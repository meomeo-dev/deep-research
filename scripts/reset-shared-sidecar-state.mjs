import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const sharedStateDir = path.join(rootDir, ".deep-research");
const pathsToRemove = [
  path.join(sharedStateDir, "crawl4ai-venv"),
  path.join(sharedStateDir, "crawl4ai-sidecar.json")
];

for (const targetPath of pathsToRemove) {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true, recursive: true });
    globalThis.console.error(`[sidecar-reset] removed ${targetPath}`);
  } else {
    globalThis.console.error(`[sidecar-reset] skipped missing ${targetPath}`);
  }
}
