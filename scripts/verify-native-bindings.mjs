import process from "node:process";

const verifyBetterSqlite3 = async () => {
  const betterSqlite3Module = await import("better-sqlite3");
  const Database = betterSqlite3Module.default;
  const db = new Database(":memory:");
  db.prepare("select 1 as value").get();
  db.close();
};

const verifyEsbuild = async () => {
  const esbuild = await import("esbuild");
  await esbuild.transform("const answer = 42;", {
    format: "esm",
    loader: "js"
  });
};

const checks = [
  { label: "better-sqlite3", run: verifyBetterSqlite3 },
  { label: "esbuild", run: verifyEsbuild }
];

const failures = [];

for (const check of checks) {
  try {
    await check.run();
    globalThis.console.error(`[native-check] ${check.label} OK`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${check.label}: ${message}`);
  }
}

if (failures.length > 0) {
  globalThis.console.error("[native-check] native dependency verification failed");
  for (const failure of failures) {
    globalThis.console.error(`[native-check] ${failure}`);
  }
  globalThis.console.error(
    "[native-check] If install logs mentioned ignored build scripts, run: pnpm rebuild better-sqlite3 esbuild"
  );
  globalThis.console.error(
    "[native-check] If better-sqlite3 still fails, run: npm rebuild better-sqlite3"
  );
  globalThis.console.error(
    "[native-check] If pnpm still blocks builds, check pnpm approve-builds and ensure ignore-scripts is not forced to true (for example: pnpm config set ignore-scripts false)"
  );
  process.exitCode = 1;
} else {
  globalThis.console.error("[native-check] all native dependencies are ready");
}
