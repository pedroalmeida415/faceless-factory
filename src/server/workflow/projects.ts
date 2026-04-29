import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import {
  createEmptyWorkflowDocument,
  deserializeStoredWorkflowGraphDocument,
  hydrateWorkflowGraphDocument,
  toWorkflowDefinitionGraphDocument,
  type WorkflowGraphDocument,
} from "~/lib/workflow/document";
import {
  WorkflowAuthorizationError,
  WorkflowValidationError,
} from "~/lib/workflow/errors";
import { extractWorkflowExecutionSubgraph } from "~/lib/workflow/execution/subgraph";
import {
  DEFAULT_WORKFLOW_PROJECT_NAME,
  type WorkflowProject,
  type WorkflowProjectSaveResponse,
} from "~/lib/workflow/project";
import { WorkflowGraphValidator } from "~/lib/workflow/workflow-graph-validator";
import { db } from "~/server/db";
import { workflows } from "~/server/db/schema";

type WorkflowProjectRow = typeof workflows.$inferSelect;

async function getWorkflowProjectRow(params: {
  ownerUserId: string;
  projectId: string;
}) {
  const [project] = await db
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
    throw new WorkflowAuthorizationError({
      message: `Workflow project ${params.projectId} was not found.`,
    });
  }

  return project;
}

function toWorkflowProject(row: WorkflowProjectRow): WorkflowProject {
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
  };
}

function assertLockedExecutionSliceUnchanged(params: {
  currentDocument: WorkflowGraphDocument;
  lockedTargetNodeIds: string[];
  nextDocument: WorkflowGraphDocument;
}) {
  if (!params.lockedTargetNodeIds.length) {
    return;
  }

  const currentDocument = hydrateWorkflowGraphDocument(params.currentDocument);
  const nextDocument = hydrateWorkflowGraphDocument(params.nextDocument);
  if (!currentDocument || !nextDocument) {
    throw new WorkflowValidationError({
      message: "Workflow project contains an invalid graph document.",
    });
  }

  const currentSlice = extractWorkflowExecutionSubgraph(
    currentDocument,
    params.lockedTargetNodeIds,
  );
  const nextSlice = extractWorkflowExecutionSubgraph(
    nextDocument,
    params.lockedTargetNodeIds,
  );

  if (JSON.stringify(currentSlice) === JSON.stringify(nextSlice)) {
    return;
  }

  throw new WorkflowValidationError({
    message: "Cannot edit nodes that are participating in a running workflow.",
  });
}

export async function getOrCreateWorkflowProject(
  ownerUserId: string,
): Promise<WorkflowProject> {
  const now = new Date();
  const [existingProject] = await db
    .select()
    .from(workflows)
    .where(eq(workflows.ownerUserId, ownerUserId))
    .orderBy(desc(workflows.lastOpenedAt), desc(workflows.updatedAt))
    .limit(1);

  if (!existingProject) {
    const [createdProject] = await db
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
      throw new WorkflowValidationError({
        message: "Failed to create a workflow project.",
      });
    }

    return toWorkflowProject(createdProject);
  }

  const [updatedProject] = await db
    .update(workflows)
    .set({ lastOpenedAt: now })
    .where(eq(workflows.id, existingProject.id))
    .returning();

  return toWorkflowProject(updatedProject ?? existingProject);
}

export async function assertWorkflowProjectAccess(params: {
  ownerUserId: string;
  projectId: string;
}) {
  await getWorkflowProjectRow(params);
}

export async function getWorkflowProject(params: {
  ownerUserId: string;
  projectId: string;
}): Promise<WorkflowProject> {
  return toWorkflowProject(await getWorkflowProjectRow(params));
}

export async function saveWorkflowProjectDocument(params: {
  document: WorkflowGraphDocument;
  documentRevision: number;
  lockedNodeIds?: string[];
  ownerUserId: string;
  projectId: string;
}): Promise<WorkflowProjectSaveResponse> {
  const nextGraphDocument = deserializeStoredWorkflowGraphDocument(
    params.document,
  );
  const nextDocument = nextGraphDocument
    ? hydrateWorkflowGraphDocument(nextGraphDocument)
    : null;
  if (!nextGraphDocument || !nextDocument) {
    throw new WorkflowValidationError({
      message: "Workflow project contains an invalid graph document.",
    });
  }
  WorkflowGraphValidator.validateDocument(nextDocument);
  const nextDefinitionDocument =
    toWorkflowDefinitionGraphDocument(nextDocument);

  const currentProject = await getWorkflowProject({
    ownerUserId: params.ownerUserId,
    projectId: params.projectId,
  });

  assertLockedExecutionSliceUnchanged({
    currentDocument: currentProject.document,
    lockedTargetNodeIds: params.lockedNodeIds ?? [],
    nextDocument,
  });

  if (
    JSON.stringify(
      toWorkflowDefinitionGraphDocument(currentProject.document),
    ) === JSON.stringify(nextDefinitionDocument)
  ) {
    return {
      documentRevision: currentProject.documentRevision,
    };
  }

  if (currentProject.documentRevision !== params.documentRevision) {
    throw new WorkflowValidationError({
      message: "Workflow project changed while saving. Try again.",
    });
  }

  const [updatedProject] = await db
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
    throw new WorkflowValidationError({
      message: "Workflow project changed while saving. Try again.",
    });
  }

  return updatedProject;
}
