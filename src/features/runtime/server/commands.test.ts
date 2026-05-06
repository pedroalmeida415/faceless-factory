import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect, Layer, Schedule } from "effect";
import type { RuntimeRepositoryForCommands } from "~/features/runtime/server/command-types";
import {
  EventPublisherService,
  RuntimeCommands,
  RuntimeIdGenerator,
  RuntimeRepository,
} from "~/features/runtime/server/commands";
import {
  type PostCommitWork,
  RuntimePostCommitWork,
} from "~/features/runtime/server/post-commit-work";
import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
} from "~/features/workflow/document";
import { QueueService } from "~/server/services/queue";
import { TelemetryService } from "~/server/services/telemetry";

describe("RuntimeCommands", () => {
  test("maps stale Task Run settlement attempts to ignored outcomes", async () => {
    const layer = makeRuntime({
      settleTaskRunCompletion: () =>
        Effect.fail({
          _tag: "StaleTaskRunTransition",
          attempt: 1,
          operation: "settleTaskRunCompletion",
          taskRunId: "task-run-1",
        }),
    });

    const outcome = await Effect.runPromise(
      Effect.flatMap(RuntimeCommands, (commands) =>
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
      ).pipe(Effect.provide(layer)),
    );

    assert.deepEqual(outcome, {
      reason: "STALE_TASK_RUN",
      status: "ignored",
    });
  });

  test("maps missing Wake-Up Call parents to ignored outcomes", async () => {
    const layer = makeRuntime({
      wakeUpTaskRunChildren: () =>
        Effect.fail({
          _tag: "WakeUpParentNotFound",
          ownerUserId: "owner-1",
          settledParentTaskRunId: "missing-parent",
        }),
    });

    const outcome = await Effect.runPromise(
      Effect.flatMap(RuntimeCommands, (commands) =>
        commands.handleWakeUpCall({
          ownerUserId: "owner-1",
          settledParentTaskRunId: "missing-parent",
          workflowId: "workflow-1",
        }),
      ).pipe(Effect.provide(layer)),
    );

    assert.deepEqual(outcome, {
      reason: "WAKE_UP_PARENT_NOT_FOUND",
      status: "ignored",
    });
  });

  test("maps stale Task Run cancellation attempts to ignored outcomes", async () => {
    const layer = makeRuntime({
      cancelTaskRun: () => staleTaskRunTransition(),
    });

    const outcome = await Effect.runPromise(
      Effect.flatMap(RuntimeCommands, (commands) =>
        commands.cancelTaskRun({
          attempt: 0,
          ownerUserId: "owner-1",
          taskRunId: "task-run-1",
          workflowId: "workflow-1",
        }),
      ).pipe(Effect.provide(layer)),
    );

    assert.deepEqual(outcome, {
      reason: "STALE_TASK_RUN",
      status: "ignored",
    });
  });

  test("maps duplicate Wake-Up Calls with no durable child changes to ignored outcomes", async () => {
    const layer = makeRuntime({
      wakeUpTaskRunChildren: () => Effect.succeed(emptyWakeUpOutcome()),
    });

    const outcome = await Effect.runPromise(
      Effect.flatMap(RuntimeCommands, (commands) =>
        commands.handleWakeUpCall({
          ownerUserId: "owner-1",
          settledParentTaskRunId: "parent-task-run-1",
          workflowId: "workflow-1",
        }),
      ).pipe(Effect.provide(layer)),
    );

    assert.deepEqual(outcome, {
      reason: "STALE_TASK_RUN",
      status: "ignored",
    });
  });

  test("keeps committed outcomes when Post-Commit Work delivery fails", async () => {
    const layer = makeRuntime(
      {
        settleTaskRunCompletion: () =>
          Effect.succeed({
            postCommitWork: {
              executionJobs: [],
              source: "settle-worker-completion" as const,
              taskStatusEvents: [
                {
                  attempt: 0,
                  itemIndex: 0,
                  nodeExecutionId: "node-execution-1",
                  status: "APPROVED" as const,
                  taskRunId: "task-run-1",
                },
              ],
              wakeUpJobs: [],
              workflowId: "workflow-1",
            },
            value: {
              event: {
                attempt: 0,
                itemIndex: 0,
                nodeExecutionId: "node-execution-1",
                status: "APPROVED" as const,
                taskRunId: "task-run-1",
              },
              settled: true,
              wakeUpJob: null,
            },
          }),
      },
      {
        publishTaskStatusEvent: () =>
          Effect.fail(new Error("redis unavailable")),
      },
    );

    const outcome = await Effect.runPromise(
      Effect.flatMap(RuntimeCommands, (commands) =>
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
      ).pipe(Effect.provide(layer)),
    );

    assert.equal(outcome.status, "committed");
  });

  test("delivers committed Wake-Up Call Post-Commit Work through the command seam", async () => {
    const delivered: PostCommitWork[] = [];
    const executionJob = {
      attempt: 0,
      itemIndex: 0,
      jobId: "task-run~child-task-run-1~attempt~0~execute",
      nodeExecutionId: "child-node-execution-1",
      ownerUserId: "owner-1",
      taskRunId: "child-task-run-1",
      workflowId: "workflow-1",
    };
    const taskStatusEvent = {
      attempt: 0,
      itemIndex: 0,
      nodeExecutionId: "child-node-execution-1",
      status: "QUEUED" as const,
      taskRunId: "child-task-run-1",
    };
    const layer = makeRuntimeWithPostCommitWork(
      {
        wakeUpTaskRunChildren: () =>
          Effect.succeed({
            postCommitWork: {
              executionJobs: [executionJob],
              source: "handle-wake-up-call" as const,
              taskStatusEvents: [taskStatusEvent],
              wakeUpJobs: [],
              workflowId: "workflow-1",
            },
            value: {
              executionJobs: [executionJob],
              parentFound: true,
              taskStatusEvents: [taskStatusEvent],
            },
          }),
      },
      delivered,
    );

    const outcome = await Effect.runPromise(
      Effect.flatMap(RuntimeCommands, (commands) =>
        commands.handleWakeUpCall({
          ownerUserId: "owner-1",
          settledParentTaskRunId: "parent-task-run-1",
          workflowId: "workflow-1",
        }),
      ).pipe(Effect.provide(layer)),
    );

    assert.deepEqual(outcome, {
      status: "committed",
      value: {
        executionJobs: [executionJob],
        parentFound: true,
        taskStatusEvents: [taskStatusEvent],
      },
    });
    assert.deepEqual(delivered, [
      {
        executionJobs: [executionJob],
        source: "handle-wake-up-call",
        taskStatusEvents: [taskStatusEvent],
        wakeUpJobs: [],
        workflowId: "workflow-1",
      },
    ]);
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
    const layer = makeRuntimeWithPostCommitWork(
      {
        commitWorkflowRunPlan: () =>
          Effect.succeed({
            postCommitWork: {
              executionJobs: [executionJob],
              source: "start-workflow-run" as const,
              taskStatusEvents: [taskStatusEvent],
              wakeUpJobs: [wakeUpJob],
              workflowId: "workflow-1",
            },
            value: {
              executionJobs: [executionJob],
              taskStatusEvents: [taskStatusEvent],
              wakeUpJobs: [wakeUpJob],
            },
          }),
      },
      delivered,
    );

    const outcome = await Effect.runPromise(
      Effect.flatMap(RuntimeCommands, (commands) =>
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
      ).pipe(Effect.provide(layer)),
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
    readonly publishTaskStatusEvent: (
      workflowId: string,
      event: unknown,
    ) => Effect.Effect<void, unknown>;
  }> = {},
) {
  const repository: Repository = {
    approveTaskRun: () => staleTaskRunTransition(),
    cancelTaskRun: () => staleTaskRunTransition(),
    commitWorkflowRunPlan: () =>
      Effect.succeed(emptyRepositoryOutcome("start-workflow-run")),
    rejectTaskRunAndCreateRegeneration: () => staleTaskRunTransition(),
    settleTaskRunCompletion: () => staleTaskRunTransition(),
    settleTaskRunFailure: () => staleTaskRunTransition(),
    wakeUpTaskRunChildren: () => Effect.succeed(emptyWakeUpOutcome()),
    ...repositoryOverrides,
  };

  return RuntimeCommands.Live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeRepository, repository),
        Layer.succeed(RuntimeIdGenerator, {
          createNodeExecutionId: () => "node-execution-1",
          createTaskRunId: () => "task-run-1",
        }),
        RuntimePostCommitWork.layerWithSchedule(Schedule.recurs(0)).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(QueueService, {
                enqueueExecutionJob: () => Effect.void,
                enqueueWakeUpJob: () => Effect.void,
              }),
              Layer.succeed(EventPublisherService, {
                publishTaskStatusEvent: () => Effect.void,
                ...eventPublisherOverrides,
              }),
              TelemetryService.Local,
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
    approveTaskRun: () => staleTaskRunTransition(),
    cancelTaskRun: () => staleTaskRunTransition(),
    commitWorkflowRunPlan: () =>
      Effect.succeed(emptyRepositoryOutcome("start-workflow-run")),
    rejectTaskRunAndCreateRegeneration: () => staleTaskRunTransition(),
    settleTaskRunCompletion: () => staleTaskRunTransition(),
    settleTaskRunFailure: () => staleTaskRunTransition(),
    wakeUpTaskRunChildren: () => Effect.succeed(emptyWakeUpOutcome()),
    ...repositoryOverrides,
  };

  return RuntimeCommands.Live.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RuntimeRepository, repository),
        Layer.succeed(RuntimeIdGenerator, {
          createNodeExecutionId: () => "node-execution-1",
          createTaskRunId: () => "task-run-1",
        }),
        Layer.succeed(RuntimePostCommitWork, {
          deliver: (work) =>
            Effect.sync(() => {
              delivered.push(work);
            }),
        }),
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

function staleTaskRunTransition() {
  return Effect.fail({
    _tag: "StaleTaskRunTransition" as const,
    attempt: 0,
    operation: "test",
    taskRunId: "task-run-1",
  });
}

function emptyRepositoryOutcome(source: PostCommitWork["source"]) {
  return {
    postCommitWork: {
      executionJobs: [],
      source,
      taskStatusEvents: [],
      wakeUpJobs: [],
      workflowId: "workflow-1",
    },
    value: {
      executionJobs: [],
      taskStatusEvents: [],
      wakeUpJobs: [],
    },
  };
}

function emptyWakeUpOutcome() {
  return {
    postCommitWork: {
      executionJobs: [],
      source: "handle-wake-up-call" as const,
      taskStatusEvents: [],
      wakeUpJobs: [],
      workflowId: "workflow-1",
    },
    value: {
      executionJobs: [],
      parentFound: true,
      taskStatusEvents: [],
    },
  };
}

type Repository = RuntimeRepositoryForCommands;
