import { randomUUID } from "node:crypto";

import * as PgDrizzle from "@effect/sql-drizzle/Pg";
import { and, desc, eq } from "drizzle-orm";
import { Effect } from "effect";

import {
  createEmptyWorkflowDocument,
  deserializeStoredWorkflowGraphDocument,
  hydrateWorkflowGraphDocument,
  toWorkflowDefinitionGraphDocument,
  type WorkflowGraphDocument,
} from "~/features/workflow/document";
import {
  WorkflowAuthorizationError,
  WorkflowValidationError,
} from "~/features/workflow/errors";
import {
  DEFAULT_WORKFLOW_PROJECT_NAME,
  type WorkflowProject,
  type WorkflowProjectSaveResponse,
} from "~/features/workflow/project";
import { assertActiveTaskSaveAllowed } from "~/features/workflow/save-lock-policy";
import { WorkflowGraphValidator } from "~/features/workflow/workflow-graph-validator";
import { workflows } from "~/server/database/schema";
import { DatabaseService } from "~/server/services/database";

type WorkflowProjectRow = typeof workflows.$inferSelect;

function toWorkflowProject(row: WorkflowProjectRow) {
  return Effect.try({
    try: () => {
      const document = deserializeStoredWorkflowGraphDocument(row.document);
      const definitionDocument = document
        ? toWorkflowDefinitionGraphDocument(document)
        : null;
      const hydratedDocument = definitionDocument
        ? hydrateWorkflowGraphDocument(definitionDocument)
        : null;

      if (!hydratedDocument) {
        throw new WorkflowValidationError({
          message: `Workflow project ${row.id} contains an invalid document.`,
        });
      }

      return {
        id: row.id,
        name: row.name,
        document: hydratedDocument,
        documentRevision: row.documentRevision,
      } satisfies WorkflowProject;
    },
    catch: (cause) =>
      cause instanceof WorkflowValidationError
        ? cause
        : new WorkflowValidationError({
            message: `Workflow project ${row.id} contains an invalid document.`,
            cause,
          }),
  });
}

export function getOrCreateWorkflowProject(ownerUserId: string) {
  return Effect.flatMap(DatabaseService, (database) =>
    database.run(
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle;
        const now = new Date();
        const [existingProject] = yield* db
          .select()
          .from(workflows)
          .where(eq(workflows.ownerUserId, ownerUserId))
          .orderBy(desc(workflows.lastOpenedAt), desc(workflows.updatedAt))
          .limit(1);

        if (!existingProject) {
          const [createdProject] = yield* db
            .insert(workflows)
            .values({
              document: toWorkflowDefinitionGraphDocument(
                createEmptyWorkflowDocument(),
              ),
              id: randomUUID(),
              lastOpenedAt: now,
              name: DEFAULT_WORKFLOW_PROJECT_NAME,
              ownerUserId,
              updatedAt: now,
            })
            .returning();

          if (!createdProject) {
            return yield* Effect.fail(
              new WorkflowValidationError({
                message: "Failed to create a workflow project.",
              }),
            );
          }

          return yield* toWorkflowProject(createdProject);
        }

        const [updatedProject] = yield* db
          .update(workflows)
          .set({ lastOpenedAt: now })
          .where(eq(workflows.id, existingProject.id))
          .returning();

        return yield* toWorkflowProject(updatedProject ?? existingProject);
      }),
    ),
  );
}

export function assertWorkflowProjectAccess(params: {
  ownerUserId: string;
  projectId: string;
}) {
  return Effect.asVoid(getWorkflowProjectRow(params));
}

export function getWorkflowProject(params: {
  ownerUserId: string;
  projectId: string;
}) {
  return Effect.flatMap(getWorkflowProjectRow(params), toWorkflowProject);
}

export function saveWorkflowProjectDocument(params: {
  document: WorkflowGraphDocument;
  documentRevision: number;
  lockedNodeIds?: string[];
  ownerUserId: string;
  projectId: string;
}) {
  return Effect.gen(function* () {
    const nextDocument = yield* parseWorkflowGraphDocument(params.document);
    const nextDefinitionDocument =
      toWorkflowDefinitionGraphDocument(nextDocument);
    const currentProject = yield* getWorkflowProject({
      ownerUserId: params.ownerUserId,
      projectId: params.projectId,
    });

    yield* Effect.try({
      try: () =>
        assertActiveTaskSaveAllowed({
          activeTargetNodeIds: params.lockedNodeIds ?? [],
          currentDocument: currentProject.document,
          nextDocument,
        }),
      catch: (cause) =>
        cause instanceof WorkflowValidationError
          ? cause
          : new WorkflowValidationError({
              message: "Workflow project cannot be saved right now.",
              cause,
            }),
    });

    if (
      JSON.stringify(
        toWorkflowDefinitionGraphDocument(currentProject.document),
      ) === JSON.stringify(nextDefinitionDocument)
    ) {
      return {
        documentRevision: currentProject.documentRevision,
      } satisfies WorkflowProjectSaveResponse;
    }

    if (currentProject.documentRevision !== params.documentRevision) {
      return yield* Effect.fail(
        new WorkflowValidationError({
          message: "Workflow project changed while saving. Try again.",
        }),
      );
    }

    const database = yield* DatabaseService;

    return yield* database.run(
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle;
        const [updatedProject] = yield* db
          .update(workflows)
          .set({
            document: nextDefinitionDocument,
            documentRevision: params.documentRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workflows.documentRevision, params.documentRevision),
              eq(workflows.id, params.projectId),
              eq(workflows.ownerUserId, params.ownerUserId),
            ),
          )
          .returning({
            documentRevision: workflows.documentRevision,
          });

        if (!updatedProject) {
          return yield* Effect.fail(
            new WorkflowValidationError({
              message: "Workflow project changed while saving. Try again.",
            }),
          );
        }

        return updatedProject satisfies WorkflowProjectSaveResponse;
      }),
    );
  });
}

function getWorkflowProjectRow(params: {
  ownerUserId: string;
  projectId: string;
}) {
  return Effect.flatMap(DatabaseService, (database) =>
    database.run(
      Effect.gen(function* () {
        const db = yield* PgDrizzle.PgDrizzle;
        const [project] = yield* db
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.id, params.projectId),
              eq(workflows.ownerUserId, params.ownerUserId),
            ),
          )
          .limit(1);

        if (!project) {
          return yield* Effect.fail(
            new WorkflowAuthorizationError({
              message: `Workflow project ${params.projectId} was not found.`,
            }),
          );
        }

        return project;
      }),
    ),
  );
}

function parseWorkflowGraphDocument(document: WorkflowGraphDocument) {
  return Effect.try({
    try: () => {
      const nextGraphDocument =
        deserializeStoredWorkflowGraphDocument(document);
      const nextDocument = nextGraphDocument
        ? hydrateWorkflowGraphDocument(nextGraphDocument)
        : null;
      if (!nextGraphDocument || !nextDocument) {
        throw new WorkflowValidationError({
          message: "Workflow project contains an invalid graph document.",
        });
      }
      WorkflowGraphValidator.validateDocument(nextDocument);
      return nextDocument;
    },
    catch: (cause) =>
      cause instanceof WorkflowValidationError
        ? cause
        : new WorkflowValidationError({
            message: "Workflow project contains an invalid graph document.",
            cause,
          }),
  });
}
