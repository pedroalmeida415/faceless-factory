import { beforeAll, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { SqlClient } from "@effect/sql";
import { type Context, Effect } from "effect";

import { WorkflowAuthorizationError } from "~/features/workflow/errors";
import {
  getOrCreateWorkflowProject,
  getWorkflowProject,
  saveWorkflowProjectDocument,
} from "~/features/workflow/server/projects";
import { ServerTestRuntime } from "~/server/effect";
import { DatabaseService } from "~/server/services/database";

let database: Context.Tag.Service<typeof DatabaseService>;

describe.serial("workflow project persistence", () => {
  beforeAll(async () => {
    database = await ServerTestRuntime.runPromise(DatabaseService);
  });

  beforeEach(async () => {
    await ServerTestRuntime.runPromise(
      database.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`delete from workflows`;
          yield* sql`delete from "user"`;
          yield* sql`insert into "user" (id, name, email, email_verified, credit_balance, created_at, updated_at) values ('owner-user', 'Owner', 'owner@example.com', false, 100, now(), now())`;
          yield* sql`insert into "user" (id, name, email, email_verified, credit_balance, created_at, updated_at) values ('other-user', 'Other', 'other@example.com', false, 100, now(), now())`;
        }),
      ),
    );
  });

  test("creates, reads, and saves a saved workflow document blueprint through DatabaseService", async () => {
    const created = await ServerTestRuntime.runPromise(
      getOrCreateWorkflowProject("owner-user"),
    );
    const loaded = await ServerTestRuntime.runPromise(
      getWorkflowProject({ ownerUserId: "owner-user", projectId: created.id }),
    );
    const saveResult = await ServerTestRuntime.runPromise(
      saveWorkflowProjectDocument({
        document: loaded.document,
        documentRevision: loaded.documentRevision,
        ownerUserId: "owner-user",
        projectId: loaded.id,
      }),
    );

    assert.equal(loaded.id, created.id);
    assert.equal(saveResult.documentRevision, loaded.documentRevision);
  });

  test("denies saved workflow document access to non-owners", async () => {
    const created = await ServerTestRuntime.runPromise(
      getOrCreateWorkflowProject("owner-user"),
    );
    const error = await ServerTestRuntime.runPromise(
      Effect.flip(
        getWorkflowProject({
          ownerUserId: "other-user",
          projectId: created.id,
        }),
      ),
    );

    assert.ok(error instanceof WorkflowAuthorizationError);
  });
});
