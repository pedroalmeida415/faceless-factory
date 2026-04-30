import { Effect } from "effect";
import { z } from "zod";

import { ServerRuntime } from "~/effect/server/runtime";
import {
  deserializeStoredWorkflowGraphDocument,
  type WorkflowGraphDocument,
} from "~/lib/workflow/document";
import { ASSET_KINDS } from "~/lib/workflow/types";
import { toTRPCError } from "~/server/api/errors";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { db } from "~/server/db";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import { saveWorkflowProjectDocument } from "~/server/workflow/projects";
import { WorkflowStorage } from "~/server/workflow/storage";
import { getTaskRunProjectionForWorkflow } from "~/server/workflow-runtime/workflow-runtime-task-projection-repository";

const workflowAssetSchema = z.object({
  id: z.string(),
  kind: z.enum(ASSET_KINDS),
  source: z.enum(["upload", "generated"]),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number(),
  createdAt: z.string(),
  url: z.string(),
  storagePath: z.string().nullable(),
  externalUri: z.string().nullable(),
  model: z.string().nullable(),
});

const workflowGraphDocumentSchema = z
  .custom<WorkflowGraphDocument>(
    (value) => Boolean(deserializeStoredWorkflowGraphDocument(value)),
    "Invalid workflow graph document.",
  )
  .transform(
    (value) =>
      deserializeStoredWorkflowGraphDocument(value) as NonNullable<
        ReturnType<typeof deserializeStoredWorkflowGraphDocument>
      >,
  );

const saveWorkflowProjectSchema = z.object({
  document: workflowGraphDocumentSchema,
  documentRevision: z.number().int().nonnegative(),
  projectId: z.string().min(1),
});

const activeRuntimeTaskStatuses = new Set([
  "WAITING_UPSTREAM",
  "QUEUED",
  "RUNNING",
  "PENDING_REVIEW",
]);

export const workflowRouter = createTRPCRouter({
  listAssets: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
      }),
    )
    .output(z.array(workflowAssetSchema))
    .query(async ({ ctx, input }) =>
      ServerRuntime.runPromise(
        Effect.gen(function* () {
          const workflowStorage = yield* WorkflowStorage;
          return yield* workflowStorage.listWorkflowAssets({
            ownerUserId: ctx.session.user.id,
            workflowId: input.projectId,
          });
        }),
      ).catch((error) => {
        throw toTRPCError(error);
      }),
    ),

  saveProject: protectedProcedure
    .input(saveWorkflowProjectSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const lockedNodeIds = [
          ...new Set(
            (
              await getTaskRunProjectionForWorkflow(db, {
                ownerUserId: ctx.session.user.id,
                workflowId: input.projectId,
              })
            ).flatMap((slot) =>
              activeRuntimeTaskStatuses.has(slot.status) ? [slot.nodeId] : [],
            ),
          ),
        ];

        return await saveWorkflowProjectDocument({
          document: input.document,
          documentRevision: input.documentRevision,
          lockedNodeIds,
          ownerUserId: ctx.session.user.id,
          projectId: input.projectId,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  getCredits: protectedProcedure.query(async ({ ctx }) =>
    ServerRuntime.runPromise(
      Effect.gen(function* () {
        const workflowCreditsService = yield* WorkflowCreditsService;
        return yield* workflowCreditsService.getBalanceSummary(
          ctx.session.user.id,
        );
      }),
    ).catch((error) => {
      throw toTRPCError(error);
    }),
  ),
});
