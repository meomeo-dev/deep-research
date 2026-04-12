import fs from "node:fs";
import path from "node:path";
import { AppError } from "../shared/errors";
import { resolvePackageRoot } from "../shared/package-root";

export interface SkillbookDocument {
  characterCount: number;
  content: string;
  path: string;
  referencesRootPath: string;
  relativeLinkBasePath: string;
}

export const readSkillbook = (modulePath: string): SkillbookDocument => {
  const packageRoot = resolvePackageRoot(modulePath);
  const skillbookPath = path.join(packageRoot, "SKILL.md");
  const relativeLinkBasePath = path.dirname(skillbookPath);
  const referencesRootPath = path.join(relativeLinkBasePath, "resources", "references");

  if (!fs.existsSync(skillbookPath)) {
    throw new AppError(
      "SKILLBOOK_NOT_FOUND",
      `SKILLBOOK_NOT_FOUND: unable to locate ${skillbookPath}.`,
      2
    );
  }

  if (!fs.existsSync(referencesRootPath) || !fs.statSync(referencesRootPath).isDirectory()) {
    throw new AppError(
      "SKILLBOOK_REFERENCES_NOT_FOUND",
      `SKILLBOOK_REFERENCES_NOT_FOUND: unable to locate ${referencesRootPath}.`,
      2
    );
  }

  const content = fs.readFileSync(skillbookPath, "utf8");
  return {
    characterCount: content.length,
    content,
    path: skillbookPath,
    referencesRootPath,
    relativeLinkBasePath
  };
};