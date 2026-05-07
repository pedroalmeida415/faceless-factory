import { Effect } from "effect";
import { z } from "zod";
import { getTaskRunProjectionForWorkflow } from "~/features/runtime/server/task-projection-repository";
import {
  deserializeStoredWorkflowGraphDocument,
  type WorkflowGraphDocument,
} from "~/features/workflow/document";
import { saveWorkflowProjectDocument } from "~/features/workflow/server/projects";
import { ASSET_KINDS } from "~/features/workflow/types";
import { toTRPCError } from "~/server/api/errors";
import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { ServerRuntime } from "~/server/effect";
import { CreditsService } from "~/server/services/credits";
import { StorageService } from "~/server/services/storage";

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
          const storageService = yield* StorageService;
          return yield* storageService.listWorkflowAssets({
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
              await ServerRuntime.runPromise(
                getTaskRunProjectionForWorkflow({
                  ownerUserId: ctx.session.user.id,
                  workflowId: input.projectId,
                }),
              )
            ).flatMap((slot) =>
              activeRuntimeTaskStatuses.has(slot.status) ? [slot.nodeId] : [],
            ),
          ),
        ];

        return await ServerRuntime.runPromise(
          saveWorkflowProjectDocument({
            document: input.document,
            documentRevision: input.documentRevision,
            lockedNodeIds,
            ownerUserId: ctx.session.user.id,
            projectId: input.projectId,
          }),
        );
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  getCredits: protectedProcedure.query(async ({ ctx }) =>
    ServerRuntime.runPromise(
      Effect.gen(function* () {
        const creditsService = yield* CreditsService;
        return yield* creditsService.getBalanceSummary(ctx.session.user.id);
      }),
    ).catch((error) => {
      throw toTRPCError(error);
    }),
  ),
});
