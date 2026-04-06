import path from "node:path";
import type { Command } from "commander";
import { ResearchService } from "../application/services/research-service";
import {
  ensureProjectDataDir,
  openDatabase,
  resolveProjectPaths,
  type ProjectPaths
} from "../infrastructure/persistence/sqlite/db";
import { runMigrations } from "../infrastructure/persistence/sqlite/migrate";
import type { OutputFormat, OutputMode } from "./output";

export interface GlobalOptions {
  project?: string;
  format?: OutputFormat;
  output?: string;
  outputMode?: OutputMode;
  color?: "auto" | "always" | "never";
  noInput?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  trace?: boolean;
}

export interface CommandContext {
  options: Required<Omit<GlobalOptions, "project" | "output">> & {
    output?: string;
    project: string;
  };
  paths: ProjectPaths;
  migrations: string[];
  service: ResearchService;
  close: () => void;
}

export const addGlobalOptions = (command: Command): Command =>
  command
    .option("--project <path>", "Project root path for research state")
    .option("--format <plain|json>", "Output format", "plain")
    .option("--output <path>", "Write primary result to a file")
    .option(
      "--output-mode <auto|envelope|artifact>",
      "Output file mode for --output",
      "auto"
    )
    .option("--color <mode>", "Color mode", "auto")
    .option("--no-input", "Disable interactive prompts")
    .option("--yes", "Automatically confirm dangerous operations")
    .option("--dry-run", "Print intended changes without writing state")
    .option("--quiet", "Reduce non-critical stderr output")
    .option("--verbose", "Enable verbose diagnostics")
    .option("--trace", "Show detailed error details");

export const createContext = (command: Command): CommandContext => {
  const options = normalizeOptions(command.optsWithGlobals<GlobalOptions>());
  const paths = resolveProjectPaths(options.project);
  ensureProjectDataDir(paths);
  const db = openDatabase(paths.dbPath);
  const migrations = runMigrations(db);

  return {
    close: () => db.close(),
    migrations,
    options,
    paths,
    service: new ResearchService(db)
  };
};

const normalizeOptions = (
  options: GlobalOptions
): Required<Omit<GlobalOptions, "project" | "output">> & {
  output?: string;
  project: string;
} => ({
  color: options.color ?? "auto",
  dryRun: options.dryRun ?? false,
  format: options.format ?? "plain",
  noInput: options.noInput ?? false,
  output: options.output,
  outputMode: options.outputMode ?? "auto",
  project: path.resolve(options.project ?? process.cwd()),
  quiet: options.quiet ?? false,
  trace: options.trace ?? false,
  verbose: options.verbose ?? false,
  yes: options.yes ?? false
});