import "server-only";

import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";
import type {
  WorkflowAuthorizationError,
  WorkflowCreditsError,
  WorkflowInfrastructureError,
  WorkflowRunNotFoundError,
  WorkflowValidationError,
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
import { WorkflowRunStore } from "~/server/workflow/run-store";
import { VertexAi } from "~/server/workflow/vertex";

export class WorkflowExecutionService extends Context.Tag(
  "WorkflowExecutionService",
)<
  WorkflowExecutionService,
  {
    readonly createRun: (
      userId: string,
      request: StartWorkflowExecutionRequest,
    ) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      | WorkflowCreditsError
      | WorkflowInfrastructureError
      | WorkflowValidationError
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

      const createRun = (
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

          return yield* workflowRunStore.createRun({
            ownerUserId: userId,
            run: initialRun,
          });
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
        createRun,
        executeRun,
      });
    }),
  );
}
