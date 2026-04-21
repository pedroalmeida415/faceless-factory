import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import {
  createEmptyWorkflowDocument,
  deserializeStoredWorkflowDocument,
  type WorkflowDocument,
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
import { workflowProjects } from "~/server/db/schema";

type WorkflowProjectRow = typeof workflowProjects.$inferSelect;

async function getWorkflowProjectRow(params: {
  ownerUserId: string;
  projectId: string;
}) {
  const [project] = await db
    .select()
    .from(workflowProjects)
    .where(
      and(
        eq(workflowProjects.id, params.projectId),
        eq(workflowProjects.ownerUserId, params.ownerUserId),
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
  const document = deserializeStoredWorkflowDocument(row.document);

  if (!document) {
    throw new WorkflowValidationError({
      message: `Workflow project ${row.id} contains an invalid document.`,
    });
  }

  return {
    id: row.id,
    name: row.name,
    document,
    documentRevision: row.documentRevision,
  };
}

function applyExecutionResultsToDocument(params: {
  currentDocument: WorkflowDocument;
  executionDocument: WorkflowDocument;
  targetNodeIds: string[];
}) {
  const executionNodeById = new Map(
    params.executionDocument.nodes.map((node) => [node.id, node]),
  );

  return {
    ...params.currentDocument,
    nodes: params.currentDocument.nodes.map((node) => {
      if (!params.targetNodeIds.includes(node.id)) {
        return node;
      }

      const executionNode = executionNodeById.get(node.id);
      if (!executionNode) {
        throw new WorkflowValidationError({
          message: `Execution result for node ${node.id} is missing.`,
        });
      }

      if (node.kind !== executionNode.kind) {
        throw new WorkflowValidationError({
          message: `Execution result for node ${node.id} has an incompatible type.`,
        });
      }

      if (
        node.kind === "imageGenerator" &&
        executionNode.kind === "imageGenerator"
      ) {
        return {
          ...node,
          lastPrompt: executionNode.lastPrompt,
          outputAssets: executionNode.outputAssets,
          responseText: executionNode.responseText,
        };
      }

      if (
        node.kind === "videoGenerator" &&
        executionNode.kind === "videoGenerator"
      ) {
        return {
          ...node,
          lastPrompt: executionNode.lastPrompt,
          outputAssets: executionNode.outputAssets,
          responseText: executionNode.responseText,
        };
      }

      throw new WorkflowValidationError({
        message: `Node ${node.id} is not an executable generator target.`,
      });
    }),
  } satisfies WorkflowDocument;
}

function assertLockedExecutionSliceUnchanged(params: {
  currentDocument: WorkflowDocument;
  lockedTargetNodeIds: string[];
  nextDocument: WorkflowDocument;
}) {
  if (!params.lockedTargetNodeIds.length) {
    return;
  }

  const currentSlice = extractWorkflowExecutionSubgraph(
    params.currentDocument,
    params.lockedTargetNodeIds,
  );
  const nextSlice = extractWorkflowExecutionSubgraph(
    params.nextDocument,
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
    .from(workflowProjects)
    .where(eq(workflowProjects.ownerUserId, ownerUserId))
    .orderBy(
      desc(workflowProjects.lastOpenedAt),
      desc(workflowProjects.updatedAt),
    )
    .limit(1);

  if (!existingProject) {
    const [createdProject] = await db
      .insert(workflowProjects)
      .values({
        document: createEmptyWorkflowDocument(),
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
    .update(workflowProjects)
    .set({ lastOpenedAt: now })
    .where(eq(workflowProjects.id, existingProject.id))
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
  document: WorkflowDocument;
  documentRevision: number;
  lockedNodeIds?: string[];
  ownerUserId: string;
  projectId: string;
}): Promise<WorkflowProjectSaveResponse> {
  WorkflowGraphValidator.validateDocument(params.document);

  const currentProject = await getWorkflowProject({
    ownerUserId: params.ownerUserId,
    projectId: params.projectId,
  });

  assertLockedExecutionSliceUnchanged({
    currentDocument: currentProject.document,
    lockedTargetNodeIds: params.lockedNodeIds ?? [],
    nextDocument: params.document,
  });

  if (
    JSON.stringify(currentProject.document) === JSON.stringify(params.document)
  ) {
    return {
      documentRevision: currentProject.documentRevision,
      projectId: currentProject.id,
    };
  }

  if (currentProject.documentRevision !== params.documentRevision) {
    throw new WorkflowValidationError({
      message: "Workflow project changed while saving. Try again.",
    });
  }

  const [updatedProject] = await db
    .update(workflowProjects)
    .set({
      document: params.document,
      documentRevision: params.documentRevision + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflowProjects.documentRevision, params.documentRevision),
        eq(workflowProjects.id, params.projectId),
        eq(workflowProjects.ownerUserId, params.ownerUserId),
      ),
    )
    .returning({
      documentRevision: workflowProjects.documentRevision,
      projectId: workflowProjects.id,
    });

  if (!updatedProject) {
    throw new WorkflowValidationError({
      message: "Workflow project changed while saving. Try again.",
    });
  }

  return updatedProject;
}

export async function persistWorkflowExecutionResults(params: {
  executionDocument: WorkflowDocument;
  ownerUserId: string;
  projectId: string;
  targetNodeIds: string[];
}): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const currentProject = await getWorkflowProject({
      ownerUserId: params.ownerUserId,
      projectId: params.projectId,
    });
    const nextDocument = applyExecutionResultsToDocument({
      currentDocument: currentProject.document,
      executionDocument: params.executionDocument,
      targetNodeIds: params.targetNodeIds,
    });

    WorkflowGraphValidator.validateDocument(nextDocument);

    const [updatedProject] = await db
      .update(workflowProjects)
      .set({
        document: nextDocument,
        documentRevision: currentProject.documentRevision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(
            workflowProjects.documentRevision,
            currentProject.documentRevision,
          ),
          eq(workflowProjects.id, currentProject.id),
          eq(workflowProjects.ownerUserId, params.ownerUserId),
        ),
      )
      .returning({ documentRevision: workflowProjects.documentRevision });

    if (updatedProject) {
      return updatedProject.documentRevision;
    }
  }

  throw new WorkflowValidationError({
    message:
      "Workflow project changed while persisting execution results. Try again.",
  });
}
