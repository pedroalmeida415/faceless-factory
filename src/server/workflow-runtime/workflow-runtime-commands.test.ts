import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  WorkflowRuntimeCommands,
  WorkflowRuntimeEventPublisher,
  WorkflowRuntimeIdGenerator,
  WorkflowRuntimeQueue,
  WorkflowRuntimeRepository,
} from "~/server/workflow-runtime/workflow-runtime-commands";
import type { WorkflowRuntimeRepositoryForOrchestrator } from "~/server/workflow-runtime/workflow-runtime-orchestrator";

describe("WorkflowRuntimeCommands", () => {
  test("maps stale Task Run settlement attempts to ignored outcomes", async () => {
    const runtime = makeRuntime({
      settleTaskRunCompletion: () => Promise.resolve({ settled: false }),
    });

    const outcome = await runtime.runPromise(
      Effect.flatMap(WorkflowRuntimeCommands, (commands) =>
        commands.settleWorkerCompletion({
          attempt: 1,
          generatedAsset: {
            assetId: "asset-1",
            contentType: "text/plain",
            fileName: "asset.txt",
            kind: "text",
            sizeBytes: 5,
            storageProvider: "inline",
            text: "ignored",
          },
          ownerUserId: "owner-1",
          providerCostCredits: 1,
          reviewRequired: false,
          taskRunId: "task-run-1",
          workflowId: "workflow-1",
        }),
      ),
    );

    assert.deepEqual(outcome, {
      reason: "STALE_TASK_RUN",
      status: "ignored",
    });
  });

  test("maps missing Wake-Up Call parents to ignored outcomes", async () => {
    const runtime = makeRuntime({
      wakeUpTaskRunChildren: () =>
        Promise.resolve({
          executionJobs: [],
          parentFound: false,
          taskStatusEvents: [],
        }),
    });

    const outcome = await runtime.runPromise(
      Effect.flatMap(WorkflowRuntimeCommands, (commands) =>
        commands.handleWakeUpCall({
          ownerUserId: "owner-1",
          settledParentTaskRunId: "missing-parent",
          workflowId: "workflow-1",
        }),
      ),
    );

    assert.deepEqual(outcome, {
      reason: "WAKE_UP_PARENT_NOT_FOUND",
      status: "ignored",
    });
  });

  test("keeps committed outcomes when Post-Commit Work delivery fails", async () => {
    const runtime = makeRuntime(
      {
        settleTaskRunCompletion: () =>
          Promise.resolve({
            event: {
              attempt: 0,
              status: "APPROVED" as const,
              taskRunId: "task-run-1",
              workflowId: "workflow-1",
            },
            settled: true,
            wakeUpJob: undefined,
          }),
      },
      {
        publishTaskStatusEvents: () =>
          Promise.reject(new Error("redis unavailable")),
      },
    );

    const outcome = await runtime.runPromise(
      Effect.flatMap(WorkflowRuntimeCommands, (commands) =>
        commands.settleWorkerCompletion({
          attempt: 0,
          generatedAsset: {
            assetId: "asset-1",
            contentType: "text/plain",
            fileName: "asset.txt",
            kind: "text",
            sizeBytes: 5,
            storageProvider: "inline",
            text: "approved",
          },
          ownerUserId: "owner-1",
          providerCostCredits: 1,
          reviewRequired: false,
          taskRunId: "task-run-1",
          workflowId: "workflow-1",
        }),
      ),
    );

    assert.equal(outcome.status, "committed");
  });
});

function makeRuntime(
  repositoryOverrides: Partial<Repository>,
  eventPublisherOverrides: Partial<{
    readonly publishTaskStatusEvents: () => Promise<void>;
  }> = {},
) {
  const repository: Repository = {
    approveTaskRun: () => Promise.resolve({ decided: false }),
    cancelTaskRun: () => Promise.resolve({ decided: false }),
    commitWorkflowRunPlan: () =>
      Promise.resolve({
        executionJobs: [],
        taskStatusEvents: [],
        wakeUpJobs: [],
      }),
    rejectTaskRunAndCreateRegeneration: () =>
      Promise.resolve({ rejected: false }),
    settleTaskRunCompletion: () => Promise.resolve({ settled: false }),
    settleTaskRunFailure: () => Promise.resolve({ settled: false }),
    wakeUpTaskRunChildren: () =>
      Promise.resolve({
        executionJobs: [],
        parentFound: true,
        taskStatusEvents: [],
      }),
    ...repositoryOverrides,
  };

  return ManagedRuntime.make(
    WorkflowRuntimeCommands.Live.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(WorkflowRuntimeRepository, repository),
          Layer.succeed(WorkflowRuntimeQueue, {
            enqueueExecutionJobs: () => Promise.resolve(),
            enqueueWakeUpJobs: () => Promise.resolve(),
          }),
          Layer.succeed(WorkflowRuntimeEventPublisher, {
            publishTaskStatusEvents: () => Promise.resolve(),
            ...eventPublisherOverrides,
          }),
          Layer.succeed(WorkflowRuntimeIdGenerator, {
            createNodeExecutionId: () => "node-execution-1",
            createTaskRunId: () => "task-run-1",
          }),
        ),
      ),
    ),
  );
}

type Repository = WorkflowRuntimeRepositoryForOrchestrator;
