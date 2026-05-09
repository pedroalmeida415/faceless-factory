import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const rawDatabaseImport =
  /import\s+\{[^}]*\bdb\b[^}]*\}\s+from\s+["']~\/server\/services\/database["']/;
const testLiveDatabasePatterns = [
  {
    name: "ServerRuntime",
    pattern:
      /import\s+\{[^}]*\bServerRuntime\b[^}]*\}\s+from\s+["']~\/server\/effect["']/,
  },
  {
    name: "DatabaseServiceLive",
    pattern:
      /import\s+\{[^}]*\bDatabaseServiceLive\b[^}]*\}\s+from\s+["']~\/server\/services\/database["']/,
  },
  {
    name: "raw db",
    pattern: rawDatabaseImport,
  },
  {
    name: "DATABASE_URL",
    pattern: /\bDATABASE_URL\b|\benv\.DATABASE_URL\b/,
  },
  {
    name: "direct postgres client",
    pattern: /\bpostgres\(|\bdrizzlePostgres\b|\bPgClient\.layer\b/,
  },
  {
    name: "Live layer",
    pattern: /\.Live\b|\b[A-Za-z0-9]+Live\b/,
  },
];

const allowedRawDatabaseImportFiles = new Set([
  "src/features/auth/server/config.ts",
]);
const allowedLiveDatabasePatternTestFiles = new Set([
  "src/server/services/database-import-guard.test.ts",
  "src/server/services/database.test.ts",
]);

describe("database service import guard", () => {
  test("keeps raw database access out of app-owned modules", async () => {
    const root = process.cwd();
    const offenders: string[] = [];

    for (const filePath of await listTypeScriptFiles(join(root, "src"))) {
      const projectPath = relative(root, filePath);
      if (allowedRawDatabaseImportFiles.has(projectPath)) {
        continue;
      }

      if (rawDatabaseImport.test(await readFile(filePath, "utf8"))) {
        offenders.push(projectPath);
      }
    }

    assert.deepEqual(offenders, []);
  });

  test("keeps tests on PGlite-backed database layers", async () => {
    const root = process.cwd();
    const offenders: string[] = [];

    for (const filePath of await listTypeScriptFiles(join(root, "src"))) {
      const projectPath = relative(root, filePath);
      if (!projectPath.endsWith(".test.ts")) {
        continue;
      }
      if (allowedLiveDatabasePatternTestFiles.has(projectPath)) {
        continue;
      }

      const content = await readFile(filePath, "utf8");
      for (const { name, pattern } of testLiveDatabasePatterns) {
        if (pattern.test(content)) {
          offenders.push(`${projectPath}: ${name}`);
        }
      }
    }

    assert.deepEqual(offenders, []);
  });
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        return listTypeScriptFiles(path);
      }

      return entry.isFile() && /\.tsx?$/.test(path) ? [path] : [];
    }),
  );

  return files.flat();
}
