import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect, Layer, ManagedRuntime, Schedule } from "effect";
import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
} from "~/lib/workflow/document";
import {
  WorkflowRuntimeCommands,
  WorkflowRuntimeEventPublisher,
  WorkflowRuntimeIdGenerator,
  WorkflowRuntimeQueue,
  WorkflowRuntimeRepository,
} from "~/server/workflow-runtime/workflow-runtime-commands";
import type { WorkflowRuntimeRepositoryForOrchestrator } from "~/server/workflow-runtime/workflow-runtime-orchestrator";
import {
  type PostCommitWork,
  WorkflowRuntimePostCommitWork,
} from "~/server/workflow-runtime/workflow-runtime-post-commit-work";
import { WorkflowRuntimeTelemetry } from "~/server/workflow-runtime/workflow-runtime-telemetry";

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
              itemIndex: 0,
              nodeExecutionId: "node-execution-1",
              status: "APPROVED" as const,
              taskRunId: "task-run-1",
            },
            settled: true,
            wakeUpJob: null,
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

  test("normalizes committed start run Post-Commit Work through the command seam", async () => {
    const delivered: PostCommitWork[] = [];
    const executionJob = {
      attempt: 0,
      itemIndex: 0,
      jobId: "task-run~task-run-1~attempt~0~execute",
      nodeExecutionId: "node-execution-1",
      ownerUserId: "owner-1",
      taskRunId: "task-run-1",
      workflowId: "workflow-1",
    };
    const wakeUpJob = {
      jobId: "wake-up~task-run-1",
      ownerUserId: "owner-1",
      parentTaskRunId: "task-run-1",
      workflowId: "workflow-1",
    };
    const taskStatusEvent = {
      attempt: 0,
      itemIndex: 0,
      nodeExecutionId: "node-execution-1",
      status: "QUEUED" as const,
      taskRunId: "task-run-1",
    };
    const runtime = makeRuntimeWithPostCommitWork(
      {
        commitWorkflowRunPlan: () =>
          Promise.resolve({
            executionJobs: [executionJob],
            taskStatusEvents: [taskStatusEvent],
            wakeUpJobs: [wakeUpJob],
          }),
      },
      delivered,
    );

    const outcome = await runtime.runPromise(
      Effect.flatMap(WorkflowRuntimeCommands, (commands) =>
        commands.startWorkflowRun({
          command: { type: "run-node", nodeId: "script" },
          document: {
            edges: [
              {
                id: "prompt-to-script",
                source: "prompt",
                sourceHandle: "text",
                target: "script",
                targetHandle: "prompt",
              },
            ],
            nodes: [
              makeWorkflowNode("prompt", "prompt"),
              makeWorkflowNode("llmGenerator", "script"),
            ],
            version: WORKFLOW_DOCUMENT_VERSION,
          },
          latestNodeExecutions: [{ id: "prompt-execution", nodeId: "prompt" }],
          latestTaskRuns: [
            {
              attempt: 0,
              id: "prompt-task-run",
              itemIndex: 0,
              nodeExecutionId: "prompt-execution",
              status: "APPROVED",
            },
          ],
          ownerId: "owner-1",
          workflowId: "workflow-1",
        }),
      ),
    );

    assert.equal(outcome.status, "committed");
    assert.deepEqual(delivered, [
      {
        executionJobs: [executionJob],
        source: "start-workflow-run",
        taskStatusEvents: [taskStatusEvent],
        wakeUpJobs: [wakeUpJob],
        workflowId: "workflow-1",
      },
    ]);
    const [deliveredWork] = delivered;
    assert.ok(deliveredWork);
    assert.equal("correlationId" in deliveredWork, false);
  });
});

function makeRuntime(
  repositoryOverrides: Partial<Repository>,
  eventPublisherOverrides: Partial<{
    readonly publishTaskStatusEvents: (
      workflowId: string,
      events: readonly unknown[],
    ) => Promise<void>;
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
          Layer.succeed(WorkflowRuntimeIdGenerator, {
            createNodeExecutionId: () => "node-execution-1",
            createTaskRunId: () => "task-run-1",
          }),
          WorkflowRuntimePostCommitWork.layerWithSchedule(
            Schedule.recurs(0),
          ).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(WorkflowRuntimeQueue, {
                  enqueueExecutionJobs: () => Promise.resolve(),
                  enqueueWakeUpJobs: () => Promise.resolve(),
                }),
                Layer.succeed(WorkflowRuntimeEventPublisher, {
                  publishTaskStatusEvents: () => Promise.resolve(),
                  ...eventPublisherOverrides,
                }),
                WorkflowRuntimeTelemetry.Local,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

function makeRuntimeWithPostCommitWork(
  repositoryOverrides: Partial<Repository>,
  delivered: PostCommitWork[],
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
          Layer.succeed(WorkflowRuntimeIdGenerator, {
            createNodeExecutionId: () => "node-execution-1",
            createTaskRunId: () => "task-run-1",
          }),
          Layer.succeed(WorkflowRuntimePostCommitWork, {
            deliver: (work) =>
              Effect.sync(() => {
                delivered.push(work);
              }),
          }),
        ),
      ),
    ),
  );
}

function makeWorkflowNode(
  kind: Parameters<typeof createWorkflowNode>[0],
  id: string,
) {
  const node = { ...createWorkflowNode(kind, 0), id };

  return node.kind === "prompt"
    ? {
        ...node,
        prompt: "{{prompt}}",
        variables: [{ key: "prompt", label: "Prompt" }],
      }
    : node;
}

type Repository = WorkflowRuntimeRepositoryForOrchestrator;
