import "server-only";

import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";
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
import { WorkflowRunStore } from "~/server/workflow/run-store";
import { VertexAi } from "~/server/workflow/vertex";

export class WorkflowExecutionService extends Context.Tag(
  "WorkflowExecutionService",
)<
  WorkflowExecutionService,
  {
    readonly createRun: (
      request: StartWorkflowExecutionRequest,
    ) => Effect.Effect<WorkflowExecutionStatusResponse>;
    readonly executeRun: (
      runId: string,
      request: StartWorkflowExecutionRequest,
    ) => Effect.Effect<
      WorkflowExecutionStatusResponse,
      WorkflowExecutionPortError
    >;
  }
>() {
  static readonly functions = Effect.serviceFunctions(this);

  static readonly Live = Layer.effect(
    this,
    Effect.gen(function* () {
      const vertexAi = yield* VertexAi;
      const workflowRunStore = yield* WorkflowRunStore;

      const createRun = (request: StartWorkflowExecutionRequest) =>
        Effect.gen(function* () {
          const runId = randomUUID();
          const initialRun = buildWorkflowExecutionStatusResponse({
            runId,
            document: request.document,
            runtime: createWorkflowExecutionRuntimeState(
              request.document,
              "Queued workflow run.",
            ),
            status: "queued",
          });

          return yield* workflowRunStore.createRun(initialRun);
        });

      const executeRun = (
        runId: string,
        request: StartWorkflowExecutionRequest,
      ) =>
        executeWorkflow({
          request,
          runId,
          ports: {
            generateImage: vertexAi.generateImagesWithNanoBananaPro,
            generateVideo: vertexAi.generateVideosWithVeo31,
            onStateChange: (state) =>
              workflowRunStore
                .updateRun(state)
                .pipe(Effect.orDie, Effect.asVoid),
          },
        });

      return WorkflowExecutionService.of({
        createRun,
        executeRun,
      });
    }),
  );
}
