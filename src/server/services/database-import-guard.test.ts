import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const rawDatabaseImport =
  /import\s+\{[^}]*\bdb\b[^}]*\}\s+from\s+["']~\/server\/services\/database["']/;

const allowedRawDatabaseImportFiles = new Set([
  "src/features/auth/server/config.ts",
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
