import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface ProjectPaths {
  projectRoot: string;
  dataDir: string;
  dbPath: string;
  recentRefsPath: string;
}

export const resolveProjectPaths = (projectRoot: string): ProjectPaths => ({
  projectRoot,
  dataDir: path.join(projectRoot, ".deep-research"),
  dbPath: path.join(projectRoot, ".deep-research", "deep-research.sqlite"),
  recentRefsPath: path.join(projectRoot, ".deep-research", "recent-refs.json")
});

export const ensureProjectDataDir = (paths: ProjectPaths): void => {
  fs.mkdirSync(paths.dataDir, { recursive: true });
};

export const openDatabase = (dbPath: string): Database.Database => {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  return db;
};