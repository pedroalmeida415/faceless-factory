import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";
import {
  getErrorMessage,
  type WorkflowAuthorizationError,
  type WorkflowCreditsError,
  WorkflowInfrastructureError,
  type WorkflowRunNotFoundError,
  type WorkflowValidationError,
} from "~/lib/workflow/errors";
import { executeWorkflow } from "~/lib/workflow/execution/core";
import {
  buildWorkflowExecutionStatusResponse,
  createWorkflowExecutionRuntimeState,
} from "~/lib/workflow/execution/runtime-state";
import type {
  StartWorkflowExecutionRequest,
  WorkflowExecutionPortError,
  WorkflowExecutionStatusResponse,
} from "~/lib/workflow/execution/types";
import { WorkflowCreditsService } from "~/server/workflow/credits";
import {
  priceImageGeneration,
  priceVideoGeneration,
  quoteWorkflowExecution,
} from "~/server/workflow/pricing";
import { enqueueWorkflowExecutionJob } from "~/server/workflow/queue";
import { WorkflowRunStore } from "~/server/workflow/run-store";
import { VertexAi } from "~/server/workflow/vertex";

export class WorkflowExecutionService extends Context.Tag(
  "WorkflowExecutionService",
)<
  WorkflowExecutionService,
  {
    readonly startRun: (
      userId: string,
      request: StartWorkflowExecutionRequest,
    ) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowCreditsError
      | WorkflowInfrastructureError
      | WorkflowValidationError
    >;
    readonly failRun: (params: {
      message: string;
      runId: string;
      userId: string;
    }) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowInfrastructureError
      | WorkflowRunNotFoundError
    >;
    readonly executeRun: (
      runId: string,
      userId: string,
      request: StartWorkflowExecutionRequest,
    ) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowAuthorizationError
      | WorkflowCreditsError
      | WorkflowExecutionPortError
      | WorkflowInfrastructureError
      | WorkflowRunNotFoundError
    >;
  }
>() {
  static readonly functions = Effect.serviceFunctions(this);

  static readonly Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const vertexAi = yield* VertexAi;
      const workflowCreditsService = yield* WorkflowCreditsService;
      const workflowRunStore = yield* WorkflowRunStore;

      const failRun = (params: {
        message: string;
        runId: string;
        userId: string;
      }) =>
        Effect.gen(function* () {
          const currentRun = yield* workflowRunStore.getRun({
            runId: params.runId,
            userId: params.userId,
          });

          if (
            currentRun.status === "error" ||
            currentRun.status === "success"
          ) {
            return currentRun;
          }

          const credits = yield* workflowCreditsService.refundRemainingCredits({
            runId: params.runId,
            userId: params.userId,
          });

          return yield* workflowRunStore.updateRun({
            ...currentRun,
            activity: params.message,
            credits,
            runtime: {
              ...currentRun.runtime,
              activity: params.message,
              error: params.message,
              finishedAt:
                currentRun.runtime.finishedAt ?? new Date().toISOString(),
            },
            status: "error",
          });
        });

      const startRun = (
        userId: string,
        request: StartWorkflowExecutionRequest,
      ) =>
        Effect.gen(function* () {
          const runId = randomUUID();
          const priceQuote = quoteWorkflowExecution(request);
          const credits = yield* workflowCreditsService.reserveCredits({
            runId,
            userId,
            totalCost: priceQuote.totalCost,
          });
          const initialRun = buildWorkflowExecutionStatusResponse({
            runId,
            document: request.document,
            runtime: createWorkflowExecutionRuntimeState(
              request.document,
              "Queued workflow run.",
            ),
            credits,
            status: "queued",
          });

          const run = yield* workflowRunStore
            .createRun({
              ownerUserId: userId,
              run: initialRun,
            })
            .pipe(
              Effect.catchAll((error) =>
                workflowCreditsService
                  .refundRemainingCredits({
                    runId,
                    userId,
                  })
                  .pipe(
                    Effect.catchAll((cleanupError) => {
                      console.error(
                        "Failed to refund credits after run creation failure",
                        cleanupError,
                      );
                      return Effect.void;
                    }),
                    Effect.zipRight(Effect.fail(error)),
                  ),
              ),
            );

          yield* Effect.tryPromise({
            try: () =>
              enqueueWorkflowExecutionJob({
                request,
                runId,
                userId,
              }),
            catch: (cause) =>
              new WorkflowInfrastructureError({
                message: getErrorMessage(cause),
                cause,
              }),
          }).pipe(
            Effect.catchAll((error) =>
              failRun({
                message: "Failed to queue workflow run.",
                runId,
                userId,
              }).pipe(
                Effect.catchAll((cleanupError) => {
                  console.error(
                    "Failed to mark workflow run as errored after queue failure",
                    cleanupError,
                  );
                  return Effect.void;
                }),
                Effect.zipRight(Effect.fail(error)),
              ),
            ),
          );

          return run;
        });

      const executeRun = (
        runId: string,
        userId: string,
        request: StartWorkflowExecutionRequest,
      ) =>
        executeWorkflow({
          request,
          runId,
          ports: {
            generateImage: (imageRequest) =>
              vertexAi.generateImagesWithNanoBananaPro(imageRequest).pipe(
                Effect.tap(() =>
                  workflowCreditsService.consumeReservedCredits({
                    runId,
                    userId,
                    cost: priceImageGeneration(imageRequest),
                  }),
                ),
              ),
            generateVideo: (videoRequest) =>
              vertexAi.generateVideosWithVeo31(videoRequest).pipe(
                Effect.tap(() =>
                  workflowCreditsService.consumeReservedCredits({
                    runId,
                    userId,
                    cost: priceVideoGeneration(videoRequest),
                  }),
                ),
              ),
            onStateChange: (state) =>
              Effect.gen(function* () {
                const credits = yield* workflowCreditsService.getRunSummary({
                  runId,
                  userId,
                });
                yield* workflowRunStore
                  .updateRun({
                    ...state,
                    credits,
                  })
                  .pipe(Effect.orDie, Effect.asVoid);
              }).pipe(Effect.orDie),
          },
        }).pipe(
          Effect.tap((state) =>
            Effect.gen(function* () {
              const credits = yield* workflowCreditsService.finalizeReservation(
                {
                  runId,
                  userId,
                },
              );
              return yield* workflowRunStore.updateRun({
                ...state,
                credits,
              });
            }),
          ),
          Effect.catchAll((error) =>
            Effect.gen(function* () {
              const credits =
                yield* workflowCreditsService.refundRemainingCredits({
                  runId,
                  userId,
                });
              const currentRun = yield* workflowRunStore.getRun({
                runId,
                userId,
              });
              yield* workflowRunStore.updateRun({
                ...currentRun,
                credits,
              });
              return yield* Effect.fail(error);
            }),
          ),
        );

      return WorkflowExecutionService.of({
        executeRun,
        failRun,
        startRun,
      });
    }),
  );
}
