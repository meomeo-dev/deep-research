import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";

const resolveBundledMigrationsDir = (): string => {
  const searchRoots = [path.dirname(fileURLToPath(import.meta.url))];

  for (const searchRoot of searchRoots) {
    let currentDir = searchRoot;
    while (true) {
      const candidateDir = path.join(currentDir, "db", "migrations");
      if (fs.existsSync(candidateDir) && fs.statSync(candidateDir).isDirectory()) {
        return candidateDir;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }
  }

  throw new Error(
    "Bundled migrations directory was not found. Expected db/migrations near the installed CLI package."
  );
};

export const runMigrations = (
  db: Database.Database
): string[] => {
  db.exec(
    `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `
  );

  const migrationsDir = resolveBundledMigrationsDir();
  const applied = new Set<string>(
    db
      .prepare("SELECT id FROM schema_migrations ORDER BY id")
      .all()
      .map((row) => String((row as { id: string }).id))
  );

  const executed: string[] = [];
  for (const fileName of fs.readdirSync(migrationsDir).sort()) {
    if (applied.has(fileName)) {
      continue;
    }
    const sql = fs.readFileSync(path.join(migrationsDir, fileName), "utf8");
    db.exec(sql);
    db.prepare(
      "INSERT INTO schema_migrations (id, applied_at) VALUES (?, datetime('now'))"
    ).run(fileName);
    executed.push(fileName);
  }
  return executed;
};