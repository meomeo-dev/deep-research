import fs from "node:fs";
import path from "node:path";
import { AppError } from "./errors";

export const resolvePackageRoot = (modulePath: string): string => {
  let cursor = path.dirname(modulePath);

  while (true) {
    const packageJsonPath = path.join(cursor, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      return cursor;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new AppError(
        "PACKAGE_ROOT_NOT_FOUND",
        "PACKAGE_ROOT_NOT_FOUND: unable to resolve the deep-research package root.",
        2
      );
    }

    cursor = parent;
  }
};