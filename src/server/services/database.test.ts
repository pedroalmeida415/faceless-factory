import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const testRoots = [
  "src/features/runtime",
  "src/features/runtime/server",
] as const;
const forbiddenTestDatabasePatterns = [
  "DATABASE_URL",
  "postgres(",
  "postgres-js",
  "PgClient.layer",
  'database: "faceless-factory"',
  "database: 'faceless-factory'",
] as const;

describe("DatabaseService test seam", () => {
  test("DB-backed runtime tests never connect to the app Postgres database", async () => {
    const offenders: string[] = [];

    for (const filePath of await testFiles(testRoots)) {
      const source = await readFile(filePath, "utf8");
      for (const pattern of forbiddenTestDatabasePatterns) {
        if (source.includes(pattern)) {
          offenders.push(`${filePath}: ${pattern}`);
        }
      }
    }

    assert.deepEqual(offenders, []);
  });
});

async function testFiles(roots: readonly string[]) {
  const files: string[] = [];

  for (const root of roots) {
    await collectTestFiles(root, files);
  }

  return files;
}

async function collectTestFiles(directory: string, files: string[]) {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectTestFiles(entryPath, files);
      continue;
    }
    if (entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }
}
