import { beforeAll, beforeEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import {
  activeGeneratorDocument,
  assertNoColonJobIds,
  assertPlanInvariants,
  assertRuntimeInvariants,
  broadcastGeneratedTextDocument,
  eventContract,
  executableSnapshot,
  FakeVertexAiService,
  generatedImageAsset,
  generatedImageToGeneratedVideoDocument,
  generatedTextAsset,
  getAssetsForTaskRun,
  getTaskDependenciesForChild,
  getTaskRunCreditState,
  getTaskRunState,
  getUserCreditBalance,
  insertGeneratedMediaAsset,
  insertGeneratedTextAsset,
  insertNodeExecution,
  insertTaskDependency,
  insertTaskRun,
  insertUser,
  latestTaskRun,
  nextId,
  outputReorderDocument,
  type RuntimeContractDatabase,
  resetRuntimeContractTables,
  setNodeExecutionOutputCount,
  setUserCreditBalance,
  setupRuntimeContractTables,
  simpleScriptDocument,
  unwrapPlan,
} from "~/features/runtime/contract-harness";
import {
  isTaskRunInputSnapshot,
  type TaskRunInputSnapshot,
} from "~/features/runtime/execution/task-run-input-snapshot";
import { planWorkflowRun } from "~/features/runtime/planning/workflow-run-planner";
import {
  RuntimeCommands,
  RuntimeIdGenerator,
  RuntimeRepository,
} from "~/features/runtime/server/commands";
import {
  type PostCommitWork,
  RuntimePostCommitWork,
} from "~/features/runtime/server/post-commit-work";
import { createRuntimeProviderExecutor } from "~/features/runtime/server/provider-executor";
import {
  createRuntimeRepository,
  createRuntimeRepositoryFromDatabase,
} from "~/features/runtime/server/repository";
import { getTaskRunProjectionForWorkflow } from "~/features/runtime/server/task-projection-repository";
import { applyTaskRunStudioProjection } from "~/features/runtime/task-run-studio-projection";
import type { WorkflowDocument } from "~/features/workflow/document";
import { WorkflowValidationError } from "~/features/workflow/errors";
import { assertActiveTaskRunSaveAllowed } from "~/features/workflow/save-lock-policy";
import { WorkflowEngine } from "~/features/workflow/workflow-engine";
import { ServerTestRuntime } from "~/server/effect";
import { DatabaseService } from "~/server/services/database";
import {
  buildRuntimeCompletionSettlementJobPayload,
  buildRuntimeExecutionJobPayload,
  buildRuntimeFailureSettlementJobPayload,
  buildRuntimeWakeUpJobPayload,
} from "~/server/services/queue";

const contractDb: RuntimeContractDatabase = {
  execute: (query) =>
    ServerTestRuntime.runPromise(
      Effect.flatMap(DatabaseService, (database) => database.execute(query)),
    ),
};

function createContractCommandRepository() {
  return ServerTestRuntime.runPromise(
    Effect.map(DatabaseService, (database) =>
      createRuntimeRepositoryFromDatabase(database),
    ),
  );
}

function createContractRepository() {
  const repository = createRuntimeRepository();
  return {
    approveTaskRun: (
      command: Omit<
        Parameters<typeof repository.approveTaskRun>[0],
        "workflowId"
      >,
    ) =>
      ServerTestRuntime.runPromise(
        repository.approveTaskRun({ ...command, workflowId: "workflow-id" }),
      ).then((outcome) => outcome.value),
    cancelTaskRun: (
      command: Omit<
        Parameters<typeof repository.cancelTaskRun>[0],
        "workflowId"
      >,
    ) =>
      ServerTestRuntime.runPromise(
        repository.cancelTaskRun({ ...command, workflowId: "workflow-id" }),
      ).then((outcome) => outcome.value),
    claimQueuedTaskRun: (
      command: Parameters<typeof repository.claimQueuedTaskRun>[0],
    ) => ServerTestRuntime.runPromise(repository.claimQueuedTaskRun(command)),
    commitWorkflowRunPlan: (
      plan: Parameters<typeof repository.commitWorkflowRunPlan>[0],
    ) =>
      ServerTestRuntime.runPromise(repository.commitWorkflowRunPlan(plan)).then(
        (outcome) => outcome.value,
      ),
    getTaskDependenciesForChild: (
      command: Parameters<typeof repository.getTaskDependenciesForChild>[0],
    ) =>
      ServerTestRuntime.runPromise(
        repository.getTaskDependenciesForChild(command),
      ),
    rejectTaskRunAndCreateRegeneration: (
      command: Parameters<
        typeof repository.rejectTaskRunAndCreateRegeneration
      >[0] extends infer T
        ? Omit<T, "workflowId">
        : never,
    ) =>
      ServerTestRuntime.runPromise(
        repository.rejectTaskRunAndCreateRegeneration({
          ...command,
          workflowId: "workflow-id",
        }),
      ).then((outcome) => outcome.value),
    settleTaskRunCompletion: (
      command: Omit<
        Parameters<typeof repository.settleTaskRunCompletion>[0],
        "workflowId"
      >,
    ) =>
      ServerTestRuntime.runPromise(
        repository.settleTaskRunCompletion({
          ...command,
          workflowId: "workflow-id",
        }),
      ).then((outcome) => outcome.value),
    settleTaskRunFailure: (
      command: Omit<
        Parameters<typeof repository.settleTaskRunFailure>[0],
        "workflowId"
      >,
    ) =>
      ServerTestRuntime.runPromise(
        repository.settleTaskRunFailure({
          ...command,
          workflowId: "workflow-id",
        }),
      ).then((outcome) => outcome.value),
    wakeUpTaskRunChildren: (
      command: Omit<
        Parameters<typeof repository.wakeUpTaskRunChildren>[0],
        "workflowId"
      >,
    ) =>
      ServerTestRuntime.runPromise(
        repository.wakeUpTaskRunChildren({
          ...command,
          workflowId: "workflow-id",
        }),
      ).then((outcome) => outcome.value),
  };
}

describe.serial("Workflow runtime state-machine contract", () => {
  let db: RuntimeContractDatabase;

  beforeAll(async () => {
    db = contractDb;
    await setupRuntimeContractTables(db);
  });

  beforeEach(async () => {
    await resetRuntimeContractTables(db);
  });

  test("Run Node command delivers Post-Commit Work after the durable commit is visible", async () => {
    await insertUser(db, { creditBalance: 100 });
    const delivered: PostCommitWork[] = [];
    const repository = await createContractCommandRepository();
    const layer = RuntimeCommands.Live.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RuntimeRepository, repository),
          Layer.succeed(RuntimeIdGenerator, {
            createNodeExecutionId: nextId("node-execution"),
            createTaskRunId: nextId("task-run"),
          }),
          Layer.succeed(RuntimePostCommitWork, {
            deliver: (work) =>
              Effect.promise(async () => {
                delivered.push(work);
                for (const job of work.executionJobs) {
                  const taskRun = await getTaskRunState(db, job.taskRunId);
                  assert.equal(taskRun.runtimeStatus, "QUEUED");
                }
                for (const event of work.taskStatusEvents) {
                  const taskRun = await getTaskRunState(db, event.taskRunId);
                  assert.equal(taskRun.runtimeStatus, event.status);
                }
              }),
          }),
        ),
      ),
    );

    const outcome = await Effect.runPromise(
      Effect.flatMap(RuntimeCommands, (commands) =>
        commands.startWorkflowRun({
          command: { type: "run-node", nodeId: "script" },
          document: simpleScriptDocument(),
          documentRevision: 1,
          latestNodeExecutions: [],
          latestTaskRuns: [],
          ownerId: "owner-user",
          workflowId: "workflow-id",
        }),
      ).pipe(Effect.provide(layer)),
    );

    assert.equal(outcome.status, "committed");
    assert.equal(delivered.length, 1);
    assert.deepEqual(delivered[0], {
      executionJobs: outcome.value.executionJobs,
      source: "start-workflow-run",
      taskStatusEvents: outcome.value.taskStatusEvents,
      wakeUpJobs: outcome.value.wakeUpJobs,
      workflowId: "workflow-id",
    });
  });

  test("planner run-node contract creates upstream closure, reuses durable batches, waits on active parents, and never creates empty executable Node Executions", () => {
    const document = generatedImageToGeneratedVideoDocument();
    const firstRunLatestTaskRuns: ReturnType<typeof latestTaskRun>[] = [];
    const firstRun = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeExecutionId: nextId("node-execution"),
        createTaskRunId: nextId("task-run"),
        document,
        documentRevision: 12,
        latestNodeExecutions: [],
        latestTaskRuns: firstRunLatestTaskRuns,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 2, video: 2 },
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(
      firstRun.nodeExecutionsToCreate.map((execution) => execution.nodeId),
      ["image", "video"],
    );
    assert.deepEqual(
      firstRun.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        itemIndex: taskRun.itemIndex,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        { attempt: 0, itemIndex: 0, nodeId: "image", status: "QUEUED" },
        { attempt: 0, itemIndex: 1, nodeId: "image", status: "QUEUED" },
        {
          attempt: 0,
          itemIndex: 0,
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
        {
          attempt: 0,
          itemIndex: 1,
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assertPlanInvariants(firstRun, document, firstRunLatestTaskRuns);

    const activeUpstreamLatestTaskRuns = [
      latestTaskRun({
        id: "image-running-0",
        nodeExecutionId: "image-execution",
        status: "RUNNING",
      }),
      latestTaskRun({
        id: "image-pending-1",
        itemIndex: 1,
        nodeExecutionId: "image-execution",
        status: "PENDING_REVIEW",
      }),
    ];
    const activeUpstreamRun = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeExecutionId: nextId("node-execution-active"),
        createTaskRunId: nextId("task-run-active"),
        document,
        latestNodeExecutions: [{ id: "image-execution", nodeId: "image" }],
        latestTaskRuns: activeUpstreamLatestTaskRuns,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 2, video: 2 },
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(activeUpstreamRun.nodeExecutionsToReuse, [
      { id: "image-execution", nodeId: "image" },
    ]);
    assert.deepEqual(
      activeUpstreamRun.taskRunsToCreate.map((taskRun) => ({
        itemIndex: taskRun.itemIndex,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        { itemIndex: 0, nodeId: "video", status: "WAITING_UPSTREAM" },
        { itemIndex: 1, nodeId: "video", status: "WAITING_UPSTREAM" },
      ],
    );
    assertPlanInvariants(
      activeUpstreamRun,
      document,
      activeUpstreamLatestTaskRuns,
    );

    const recoverableUpstreamLatestTaskRuns = [
      latestTaskRun({
        attempt: 2,
        id: "image-failed-0",
        nodeExecutionId: "image-execution",
        status: "FAILED",
      }),
      latestTaskRun({
        attempt: 4,
        id: "image-cancelled-1",
        itemIndex: 1,
        nodeExecutionId: "image-execution",
        status: "CANCELLED",
      }),
    ];
    const recoverableUpstreamRun = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeExecutionId: nextId("node-execution-recover"),
        createTaskRunId: nextId("task-run-recover"),
        document,
        latestNodeExecutions: [{ id: "image-execution", nodeId: "image" }],
        latestTaskRuns: recoverableUpstreamLatestTaskRuns,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 2, video: 2 },
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(
      recoverableUpstreamRun.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        itemIndex: taskRun.itemIndex,
        nodeExecutionId: taskRun.nodeExecutionId,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        {
          attempt: 3,
          itemIndex: 0,
          nodeExecutionId: "image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          attempt: 5,
          itemIndex: 1,
          nodeExecutionId: "image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          attempt: 0,
          itemIndex: 0,
          nodeExecutionId: "node-execution-recover-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
        {
          attempt: 0,
          itemIndex: 1,
          nodeExecutionId: "node-execution-recover-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assertPlanInvariants(
      recoverableUpstreamRun,
      document,
      recoverableUpstreamLatestTaskRuns,
    );

    const reviewBarrierLatestTaskRuns = [
      latestTaskRun({
        id: "image-approved-old",
        nodeExecutionId: "image-execution",
        status: "APPROVED",
      }),
      latestTaskRun({
        attempt: 1,
        id: "image-pending-latest",
        nodeExecutionId: "image-execution",
        status: "PENDING_REVIEW",
      }),
    ];
    const reviewBarrierRun = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        document,
        latestNodeExecutions: [{ id: "image-execution", nodeId: "image" }],
        latestTaskRuns: reviewBarrierLatestTaskRuns,
        ownerId: "owner-user",
        workflowId: "workflow-id",
      }),
    );
    assert.equal(
      reviewBarrierRun.taskRunsToCreate[0]?.status,
      "WAITING_UPSTREAM",
    );
    assertPlanInvariants(
      reviewBarrierRun,
      document,
      reviewBarrierLatestTaskRuns,
    );
  });

  test("planner run-node contract fills empty reused upstream Node Execution slots before children wait on them", () => {
    const document = generatedImageToGeneratedVideoDocument();
    const latestTaskRuns: ReturnType<typeof latestTaskRun>[] = [];
    const plan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeExecutionId: nextId(
          "runtime-node-execution-run-node-empty-parent",
        ),
        createTaskRunId: nextId("runtime-task-run-run-node-empty-parent"),
        document,
        latestNodeExecutions: [
          { id: "empty-image-execution", nodeId: "image" },
        ],
        latestTaskRuns,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 2, video: 2 },
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(plan.nodeExecutionsToReuse, [
      { id: "empty-image-execution", nodeId: "image" },
    ]);
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        itemIndex: taskRun.itemIndex,
        nodeExecutionId: taskRun.nodeExecutionId,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        {
          itemIndex: 0,
          nodeExecutionId: "empty-image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          itemIndex: 1,
          nodeExecutionId: "empty-image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          itemIndex: 0,
          nodeExecutionId: "runtime-node-execution-run-node-empty-parent-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
        {
          itemIndex: 1,
          nodeExecutionId: "runtime-node-execution-run-node-empty-parent-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childNodeId: dependency.childNodeId,
        parentItemIndex: dependency.parentItemIndex,
        parentNodeExecutionId: dependency.parentNodeExecutionId,
        parentNodeId: dependency.parentNodeId,
      })),
      [
        {
          childNodeId: "video",
          parentItemIndex: 0,
          parentNodeExecutionId: "empty-image-execution",
          parentNodeId: "image",
        },
        {
          childNodeId: "video",
          parentItemIndex: 1,
          parentNodeExecutionId: "empty-image-execution",
          parentNodeId: "image",
        },
      ],
    );
    assertPlanInvariants(plan, document, latestTaskRuns);
  });

  test("planner run-node contract fills empty reused upstream Node Execution slots before children wait on them", () => {
    const document = generatedImageToGeneratedVideoDocument();
    const latestTaskRuns: ReturnType<typeof latestTaskRun>[] = [];
    const plan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeExecutionId: nextId("runtime-node-execution-empty-parent"),
        createTaskRunId: nextId("runtime-task-run-empty-parent"),
        document,
        latestNodeExecutions: [
          { id: "empty-image-execution", nodeId: "image" },
        ],
        latestTaskRuns,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 2, video: 2 },
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(plan.nodeExecutionsToReuse, [
      { id: "empty-image-execution", nodeId: "image" },
    ]);
    assert.deepEqual(
      plan.taskRunsToCreate.map((taskRun) => ({
        itemIndex: taskRun.itemIndex,
        nodeExecutionId: taskRun.nodeExecutionId,
        nodeId: taskRun.nodeId,
        status: taskRun.status,
      })),
      [
        {
          itemIndex: 0,
          nodeExecutionId: "empty-image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          itemIndex: 1,
          nodeExecutionId: "empty-image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          itemIndex: 0,
          nodeExecutionId: "runtime-node-execution-empty-parent-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
        {
          itemIndex: 1,
          nodeExecutionId: "runtime-node-execution-empty-parent-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assertPlanInvariants(plan, document, latestTaskRuns);
  });

  test("repository and gatekeeper contract commits materialized Task Runs, gates review, freezes dependencies, and keeps Wake-Up Calls idempotent", async () => {
    const repository = createContractRepository();
    await insertUser(db, { creditBalance: 100 });
    const document = generatedImageToGeneratedVideoDocument();
    const plan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeExecutionId: nextId("runtime-node-execution"),
        createTaskRunId: nextId("runtime-task-run"),
        document,
        documentRevision: 44,
        latestNodeExecutions: [],
        latestTaskRuns: [],
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 1, video: 1 },
        workflowId: "workflow-id",
      }),
    );

    const commit = await repository.commitWorkflowRunPlan(plan);
    assert.deepEqual(
      commit.executionJobs.map((job) => job.jobId),
      ["task-run~runtime-task-run-1~attempt~0~execute"],
    );
    assertNoColonJobIds(commit.executionJobs, commit.wakeUpJobs);
    assert.deepEqual(commit.taskStatusEvents.map(eventContract), [
      {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "runtime-node-execution-1",
        status: "QUEUED",
        taskRunId: "runtime-task-run-1",
      },
      {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "runtime-node-execution-2",
        status: "WAITING_UPSTREAM",
        taskRunId: "runtime-task-run-2",
      },
    ]);
    assert.equal(await getUserCreditBalance(db, "owner-user"), 90);
    assert.deepEqual(await getTaskRunCreditState(db, "runtime-task-run-2"), {
      creditCost: 40,
      failureReason: null,
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await assertRuntimeInvariants(db);

    const claimed = await repository.claimQueuedTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "runtime-task-run-1",
    });
    assert.equal(claimed.claimed, true);
    if (!claimed.claimed)
      throw new Error("Expected queued image Task Run claim");
    assert.equal(
      claimed.inputSnapshot.providerInput.kind,
      "image-generation-request",
    );

    const pendingReview = await repository.settleTaskRunCompletion({
      attempt: 0,
      providerCostCredits: 6,
      generatedAsset: generatedImageAsset("image-asset-pending"),
      ownerUserId: "owner-user",
      reviewRequired: true,
      taskRunId: "runtime-task-run-1",
    });
    assert.equal(pendingReview.settled, true);
    assert.equal(
      pendingReview.settled ? pendingReview.event.status : null,
      "PENDING_REVIEW",
    );
    assert.equal(
      pendingReview.settled ? pendingReview.wakeUpJob : "missing",
      null,
    );
    assert.equal(
      (await getTaskRunCreditState(db, "runtime-task-run-2")).runtimeStatus,
      "WAITING_UPSTREAM",
    );

    const approved = await repository.approveTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "runtime-task-run-1",
    });
    assert.deepEqual(approved, {
      decided: true,
      event: {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "runtime-node-execution-1",
        status: "APPROVED",
        taskRunId: "runtime-task-run-1",
      },
      wakeUpJob: {
        jobId: "wake-up~runtime-task-run-1",
        ownerUserId: "owner-user",
        parentTaskRunId: "runtime-task-run-1",
        workflowId: "workflow-id",
      },
    });
    assertNoColonJobIds([approved.wakeUpJob]);

    const wake = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "runtime-task-run-1",
    });
    assert.deepEqual(
      wake.executionJobs.map((job) => job.jobId),
      ["task-run~runtime-task-run-2~attempt~0~execute"],
    );
    assert.deepEqual(wake.taskStatusEvents.map(eventContract), [
      {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "runtime-node-execution-2",
        status: "QUEUED",
        taskRunId: "runtime-task-run-2",
      },
    ]);
    assertNoColonJobIds(wake.executionJobs);
    assert.equal(await getUserCreditBalance(db, "owner-user"), 50);
    assert.deepEqual(await getTaskRunCreditState(db, "runtime-task-run-2"), {
      creditCost: 40,
      failureReason: null,
      runtimeStatus: "QUEUED",
    });
    const duplicateWake = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "runtime-task-run-1",
    });
    assert.deepEqual(duplicateWake, {
      executionJobs: [],
      parentFound: true,
      taskStatusEvents: [],
    });
    assert.equal(await getUserCreditBalance(db, "owner-user"), 50);

    const dependencies = await repository.getTaskDependenciesForChild({
      childTaskRunId: "runtime-task-run-2",
    });
    assert.equal(
      dependencies[0]?.resolvedParentTaskRunId,
      "runtime-task-run-1",
    );
    const child = await getTaskRunState(db, "runtime-task-run-2");
    assert.equal(isTaskRunInputSnapshot(child.inputSnapshot), true);
    if (!isTaskRunInputSnapshot(child.inputSnapshot)) {
      throw new Error("Expected queued child input snapshot");
    }
    assert.equal(child.inputSnapshot.documentRevision, 44);
    assert.equal(
      child.inputSnapshot.providerInput.kind,
      "video-generation-request",
    );
    assert.equal(
      child.inputSnapshot.resolvedParentTaskRuns[0]?.taskRunId,
      "runtime-task-run-1",
    );
    await assertRuntimeInvariants(db);
  });

  test("attempt contract distinguishes rejection, cancellation, failure, regeneration, rerun, and explicit recovery", async () => {
    const repository = createContractRepository();
    await insertUser(db, { creditBalance: 60 });
    await insertTaskRun(db, {
      attempt: 0,
      creditCost: 5,
      id: "review-attempt-0",
      nodeExecutionId: "node-execution-review",
      runtimeStatus: "PENDING_REVIEW",
    });

    const rejected = await repository.rejectTaskRunAndCreateRegeneration({
      attempt: 0,
      newTaskRunId: "review-attempt-1",
      ownerUserId: "owner-user",
      taskRunId: "review-attempt-0",
    });
    assert.equal(rejected.rejected, true);
    assert.deepEqual(
      rejected.rejected ? rejected.taskStatusEvents.map(eventContract) : [],
      [
        {
          attempt: 0,
          itemIndex: 0,
          nodeExecutionId: "node-execution-review",
          status: "REJECTED",
          taskRunId: "review-attempt-0",
        },
        {
          attempt: 1,
          itemIndex: 0,
          nodeExecutionId: "node-execution-review",
          status: "QUEUED",
          taskRunId: "review-attempt-1",
        },
      ],
    );
    assert.equal(
      (await getTaskRunCreditState(db, "review-attempt-0")).runtimeStatus,
      "REJECTED",
    );
    assert.equal(
      (await getTaskRunCreditState(db, "review-attempt-1")).runtimeStatus,
      "QUEUED",
    );

    await insertTaskRun(db, {
      id: "cancelled-parent",
      nodeExecutionId: "node-execution-cancel-parent",
      runtimeStatus: "QUEUED",
    });
    await insertTaskRun(db, {
      id: "waiting-child-of-cancelled",
      nodeExecutionId: "node-execution-child-of-cancelled",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "waiting-child-of-cancelled",
      parentNodeExecutionId: "node-execution-cancel-parent",
    });
    await repository.cancelTaskRun({
      attempt: 0,
      ownerUserId: "owner-user",
      taskRunId: "cancelled-parent",
    });
    await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "cancelled-parent",
    });
    assert.equal(
      (await getTaskRunCreditState(db, "cancelled-parent")).runtimeStatus,
      "CANCELLED",
    );
    assert.equal(
      (await getTaskRunCreditState(db, "waiting-child-of-cancelled"))
        .runtimeStatus,
      "UPSTREAM_FAILED",
    );

    await insertUser(db, { creditBalance: 3, id: "low-credit-user" });
    await insertTaskRun(db, {
      creditCost: 10,
      id: "unfunded-parent",
      nodeExecutionId: "node-execution-unfunded-parent",
      ownerUserId: "low-credit-user",
      runtimeStatus: "RUNNING",
    });
    await insertTaskRun(db, {
      id: "waiting-child-of-unfunded",
      nodeExecutionId: "node-execution-child-of-unfunded",
      ownerUserId: "low-credit-user",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "waiting-child-of-unfunded",
      parentNodeExecutionId: "node-execution-unfunded-parent",
    });
    await repository.settleTaskRunFailure({
      attempt: 0,
      failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
      failureSource: nonRefundableProviderFailureSource(),
      ownerUserId: "low-credit-user",
      taskRunId: "unfunded-parent",
    });
    await repository.wakeUpTaskRunChildren({
      ownerUserId: "low-credit-user",
      settledParentTaskRunId: "unfunded-parent",
    });
    assert.equal(
      (await getTaskRunCreditState(db, "waiting-child-of-unfunded"))
        .runtimeStatus,
      "UPSTREAM_FAILED",
    );

    const document = simpleScriptDocument();
    const regenerate = unwrapPlan(
      planWorkflowRun({
        command: {
          itemIndex: 1,
          nodeExecutionId: "node-execution-script-existing",
          type: "run-task-slot",
        },
        document,
        latestNodeExecutions: [
          { id: "node-execution-script-existing", nodeId: "script" },
        ],
        latestTaskRuns: [
          latestTaskRun({
            attempt: 2,
            id: "script-item-0-approved",
            itemIndex: 0,
            nodeExecutionId: "node-execution-script-existing",
            status: "APPROVED",
          }),
          latestTaskRun({
            attempt: 3,
            id: "script-item-1-cancelled",
            itemIndex: 1,
            nodeExecutionId: "node-execution-script-existing",
            status: "CANCELLED",
          }),
        ],
        ownerId: "owner-user",
        plannedItemCountByNodeId: { script: 2 },
        workflowId: "workflow-id",
      }),
    );
    assert.deepEqual(
      regenerate.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        itemIndex: taskRun.itemIndex,
        nodeExecutionId: taskRun.nodeExecutionId,
      })),
      [
        {
          attempt: 4,
          itemIndex: 1,
          nodeExecutionId: "node-execution-script-existing",
        },
      ],
    );
    const rerun = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document,
        latestNodeExecutions: [
          { id: "node-execution-script-existing", nodeId: "script" },
        ],
        latestTaskRuns: [
          latestTaskRun({
            attempt: 4,
            id: "script-item-1-approved",
            itemIndex: 1,
            nodeExecutionId: "node-execution-script-existing",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-user",
        plannedItemCountByNodeId: { script: 2 },
        workflowId: "workflow-id",
      }),
    );
    assert.notEqual(
      rerun.nodeExecutionsToCreate[0]?.id,
      "node-execution-script-existing",
    );
    assert.deepEqual(
      rerun.taskRunsToCreate.map((taskRun) => ({
        attempt: taskRun.attempt,
        itemIndex: taskRun.itemIndex,
      })),
      [
        { attempt: 0, itemIndex: 0 },
        { attempt: 0, itemIndex: 1 },
      ],
    );
    await assertRuntimeInvariants(db);
  });

  test("materialized snapshot, provider, queue, projection, and save-lock consumers obey the runtime contract", async () => {
    const jobPayloads = [
      buildRuntimeExecutionJobPayload({
        attempt: 2,
        itemIndex: 1,
        nodeExecutionId: "node-execution-queue",
        ownerUserId: "owner-user",
        taskRunId: "task-run-queue",
        workflowId: "workflow-id",
      }),
      buildRuntimeCompletionSettlementJobPayload({
        attempt: 2,
        providerCostCredits: 1,
        generatedAsset: generatedTextAsset("asset-queue", "done"),
        ownerUserId: "owner-user",
        reviewRequired: false,
        taskRunId: "task-run-queue",
        workflowId: "workflow-id",
      }),
      buildRuntimeFailureSettlementJobPayload({
        attempt: 2,
        failureReason: { message: "failed", type: "PROVIDER_FAILED" },
        failureSource: nonRefundableProviderFailureSource(),
        ownerUserId: "owner-user",
        taskRunId: "task-run-queue",
        workflowId: "workflow-id",
      }),
      buildRuntimeWakeUpJobPayload({
        ownerUserId: "owner-user",
        parentTaskRunId: "task-run-queue",
        workflowId: "workflow-id",
      }),
    ];
    assertNoColonJobIds(jobPayloads);

    const vertexAi = new FakeVertexAiService();
    const executor = createRuntimeProviderExecutor({
      createAssetId: () => "text-asset-from-snapshot",
      vertexAi,
    });
    const snapshot = executableSnapshot({
      prompt: "frozen prompt, not live graph",
      taskRunId: "task-run-provider",
    });
    await Effect.runPromise(
      executor.execute({
        inputSnapshot: snapshot,
        ownerUserId: "owner-user",
        workflowId: "workflow-id",
      }),
    );
    assert.deepEqual(
      vertexAi.llmCalls.map((call) => call.request),
      [snapshot.providerInput.request],
    );

    const currentDocument = activeGeneratorDocument();
    const movedWithRuntimePayloads = {
      ...currentDocument,
      nodes: currentDocument.nodes.map((node) => ({
        ...node,
        outputs: [{ id: "client-output" }],
        position: { x: node.position.x + 80, y: node.position.y + 40 },
        review: { items: [{ id: "client-review" }], valueType: "image" },
        selected: true,
      })),
    } as WorkflowDocument;
    assert.doesNotThrow(() =>
      assertActiveTaskRunSaveAllowed({
        activeTargetNodeIds: ["active-generator"],
        currentDocument,
        nextDocument: movedWithRuntimePayloads,
      }),
    );
    assert.throws(
      () =>
        assertActiveTaskRunSaveAllowed({
          activeTargetNodeIds: ["active-generator"],
          currentDocument,
          nextDocument: {
            ...currentDocument,
            nodes: currentDocument.nodes.map((node) => ({
              ...node,
              reviewEnabled: true,
            })),
          },
        }),
      WorkflowValidationError,
    );

    await insertNodeExecution(db, {
      id: "node-execution-projection-old",
      nodeId: "projected-node",
    });
    await insertTaskRun(db, {
      id: "projected-old-approved",
      nodeExecutionId: "node-execution-projection-old",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "projected-old-asset",
      taskRunId: "projected-old-approved",
      text: "stale text",
    });
    await insertTaskRun(db, {
      attempt: 1,
      failureReason: "PROVIDER_FAILED",
      id: "projected-latest-failed",
      nodeExecutionId: "node-execution-projection-old",
      nodeId: "projected-node",
      runtimeStatus: "FAILED",
    });
    const projection = await ServerTestRuntime.runPromise(
      getTaskRunProjectionForWorkflow({
        ownerUserId: "owner-user",
        workflowId: "workflow-id",
      }),
    );
    assert.deepEqual(projection, [
      {
        attempt: 1,
        failureReason: "PROVIDER_FAILED",
        itemIndex: 0,
        nodeExecutionId: "node-execution-projection-old",
        nodeId: "projected-node",
        status: "FAILED",
        taskRunId: "projected-latest-failed",
      },
    ]);

    const studio = WorkflowEngine.addNode(
      WorkflowEngine.createInitialState(),
      "llmGenerator",
    );
    const nodeId = studio.document.nodes[0]?.id;
    assert.ok(nodeId);
    const projectedStudio = applyTaskRunStudioProjection({
      document: studio.document,
      runtime: studio.runtime,
      slots: [
        {
          attempt: 3,
          itemIndex: 0,
          nodeExecutionId: "node-execution-studio",
          nodeId,
          output: {
            assetId: "studio-text",
            kind: "inline-text-asset",
            text: "draft",
          },
          status: "PENDING_REVIEW",
          taskRunId: "studio-task-run",
        },
      ],
    });
    assert.equal(
      projectedStudio.runtime.nodeStateById[nodeId]?.status,
      "waiting",
    );
    assert.deepEqual(projectedStudio.activeNodeIds, [nodeId]);
  });
});

describe.serial("Workflow runtime exhaustive state-machine contract", () => {
  let db: RuntimeContractDatabase;

  beforeAll(async () => {
    db = contractDb;
    await setupRuntimeContractTables(db);
  });

  beforeEach(async () => {
    await resetRuntimeContractTables(db);
  });

  test("review-disabled completion approves immediately, emits renderable output, and drafts a Wake-Up Call for children", async () => {
    const repository = createContractRepository();
    await insertTaskRun(db, {
      id: "parent-review-disabled",
      nodeExecutionId: "node-execution-parent-review-disabled",
      runtimeStatus: "RUNNING",
    });
    await insertTaskRun(db, {
      id: "child-waits-on-review-disabled",
      nodeExecutionId: "node-execution-child-review-disabled",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "child-waits-on-review-disabled",
      parentNodeExecutionId: "node-execution-parent-review-disabled",
    });

    const result = await repository.settleTaskRunCompletion({
      attempt: 0,
      providerCostCredits: 4,
      generatedAsset: generatedTextAsset(
        "asset-review-disabled",
        "approved text",
      ),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskRunId: "parent-review-disabled",
    });

    assert.deepEqual(result, {
      event: {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-parent-review-disabled",
        output: {
          assetId: "asset-review-disabled",
          kind: "inline-text-asset",
          text: "approved text",
        },
        status: "APPROVED",
        taskRunId: "parent-review-disabled",
      },
      settled: true,
      wakeUpJob: {
        jobId: "wake-up~parent-review-disabled",
        ownerUserId: "owner-user",
        parentTaskRunId: "parent-review-disabled",
        workflowId: "workflow-id",
      },
    });
    assert.equal(
      (await getTaskRunCreditState(db, "parent-review-disabled")).runtimeStatus,
      "APPROVED",
    );
    assert.deepEqual(eventContract(result.settled ? result.event : never()), {
      attempt: 0,
      itemIndex: 0,
      nodeExecutionId: "node-execution-parent-review-disabled",
      status: "APPROVED",
      taskRunId: "parent-review-disabled",
    });
    await assertRuntimeInvariants(db);
  });

  test("cancel command covers every cancellable and non-cancellable Task Run state", async () => {
    const repository = await createContractCommandRepository();
    const wakeUpJobs: ReturnType<typeof buildRuntimeWakeUpJobPayload>[] = [];
    const publishedEvents: ReturnType<typeof eventContract>[] = [];
    const layer = RuntimeCommands.Live.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RuntimeRepository, repository),
          Layer.succeed(RuntimeIdGenerator, {
            createNodeExecutionId: nextId("node-execution"),
            createTaskRunId: nextId("task-run"),
          }),
          Layer.succeed(RuntimePostCommitWork, {
            deliver: (work) =>
              Effect.sync(() => {
                publishedEvents.push(
                  ...work.taskStatusEvents.map(eventContract),
                );
                wakeUpJobs.push(...work.wakeUpJobs);
              }),
          }),
        ),
      ),
    );
    const runCancel = (taskRunId: string) =>
      Effect.runPromise(
        Effect.flatMap(RuntimeCommands, (commands) =>
          commands.cancelTaskRun({
            attempt: 0,
            ownerUserId: "owner-user",
            taskRunId,
            workflowId: "workflow-id",
          }),
        ).pipe(
          Effect.match({
            onFailure: (error) => ({ error, ok: false as const }),
            onSuccess: (outcome) => ({
              ok: true as const,
              value:
                outcome.status === "committed"
                  ? outcome.value
                  : { decided: false as const },
            }),
          }),
          Effect.provide(layer),
        ),
      );
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      creditCost: 12,
      id: "cancel-command-waiting",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskRun(db, {
      creditCost: 12,
      id: "cancel-command-queued",
      runtimeStatus: "QUEUED",
    });
    await insertTaskRun(db, {
      id: "cancel-command-running",
      runtimeStatus: "RUNNING",
    });
    await insertTaskRun(db, {
      id: "cancel-command-review",
      runtimeStatus: "PENDING_REVIEW",
    });
    for (const status of [
      "APPROVED",
      "REJECTED",
      "CANCELLED",
      "FAILED",
      "UPSTREAM_FAILED",
    ] as const) {
      await insertTaskRun(db, {
        id: `cancel-command-${status.toLowerCase()}`,
        runtimeStatus: status,
      });
    }

    const waiting = await runCancel("cancel-command-waiting");
    const queued = await runCancel("cancel-command-queued");
    const running = await runCancel("cancel-command-running");
    const pendingReview = await runCancel("cancel-command-review");
    const terminalResults = [];
    for (const status of [
      "approved",
      "rejected",
      "cancelled",
      "failed",
      "upstream_failed",
    ] as const) {
      terminalResults.push(await runCancel(`cancel-command-${status}`));
    }

    assert.equal(waiting.ok, true);
    assert.equal(waiting.ok ? waiting.value.decided : false, true);
    assert.equal(queued.ok, true);
    assert.equal(queued.ok ? queued.value.decided : false, true);
    assert.equal(running.ok, false);
    assert.deepEqual(running.ok ? null : running.error, {
      _tag: "TaskRunCancellationBlockedError",
      committed: false,
      message: "Running Task Runs cannot be cancelled.",
      reason: "RUNNING_TASK_RUN_CANCELLATION_BLOCKED",
    });
    assert.equal(pendingReview.ok, false);
    assert.deepEqual(pendingReview.ok ? null : pendingReview.error, {
      _tag: "TaskRunCancellationBlockedError",
      committed: false,
      message:
        "Pending Review Task Runs must be approved or rejected instead of cancelled.",
      reason: "PENDING_REVIEW_REQUIRES_REVIEW_DECISION",
    });
    assert.deepEqual(
      terminalResults.map((result) => (result.ok ? result.value : null)),
      [
        { decided: false },
        { decided: false },
        { decided: false },
        { decided: false },
        { decided: false },
      ],
    );
    assert.deepEqual(publishedEvents, [
      {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-cancel-command-waiting",
        status: "CANCELLED",
        taskRunId: "cancel-command-waiting",
      },
      {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-cancel-command-queued",
        status: "CANCELLED",
        taskRunId: "cancel-command-queued",
      },
    ]);
    assert.deepEqual(
      wakeUpJobs.map((job) => job.parentTaskRunId),
      ["cancel-command-waiting", "cancel-command-queued"],
    );
    assert.deepEqual(
      await getTaskRunCreditState(db, "cancel-command-waiting"),
      {
        creditCost: 12,
        failureReason: null,
        runtimeStatus: "CANCELLED",
      },
    );
    assert.deepEqual(await getTaskRunCreditState(db, "cancel-command-queued"), {
      creditCost: 12,
      failureReason: null,
      runtimeStatus: "CANCELLED",
    });
    assert.equal(
      (await getTaskRunCreditState(db, "cancel-command-running")).runtimeStatus,
      "RUNNING",
    );
    assert.equal(
      (await getTaskRunCreditState(db, "cancel-command-review")).runtimeStatus,
      "PENDING_REVIEW",
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 112);
    await assertRuntimeInvariants(db);
  });

  test("insufficient credits fail a ready child, cascade descendants, and later credits do not auto-resume", async () => {
    const repository = createContractRepository();
    await insertUser(db, { creditBalance: 5 });
    await insertTaskRun(db, {
      id: "funded-parent-approved",
      nodeExecutionId: "node-execution-funded-parent",
      runtimeStatus: "APPROVED",
    });
    await insertTaskRun(db, {
      creditCost: 20,
      id: "unfunded-child",
      nodeExecutionId: "node-execution-unfunded-child",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskRun(db, {
      creditCost: 1,
      id: "unfunded-grandchild",
      nodeExecutionId: "node-execution-unfunded-grandchild",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "unfunded-child",
      parentNodeExecutionId: "node-execution-funded-parent",
    });
    await insertTaskDependency(db, {
      childTaskRunId: "unfunded-grandchild",
      parentNodeExecutionId: "node-execution-unfunded-child",
    });

    assert.equal(
      (await getTaskRunCreditState(db, "unfunded-child")).creditCost,
      20,
    );
    const result = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "funded-parent-approved",
    });

    assert.deepEqual(result.executionJobs, []);
    assert.deepEqual(result.taskStatusEvents.map(eventContract), [
      {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-unfunded-child",
        status: "FAILED",
        taskRunId: "unfunded-child",
      },
      {
        attempt: 0,
        itemIndex: 0,
        nodeExecutionId: "node-execution-unfunded-grandchild",
        status: "UPSTREAM_FAILED",
        taskRunId: "unfunded-grandchild",
      },
    ]);
    assert.deepEqual(await getTaskRunCreditState(db, "unfunded-child"), {
      creditCost: 20,
      failureReason: "INSUFFICIENT_CREDITS",
      runtimeStatus: "FAILED",
    });
    assert.equal(
      (await getTaskRunCreditState(db, "unfunded-grandchild")).runtimeStatus,
      "UPSTREAM_FAILED",
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 5);

    await setUserCreditBalance(db, { creditBalance: 100 });
    const duplicateWake = await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "funded-parent-approved",
    });
    assert.deepEqual(duplicateWake, {
      executionJobs: [],
      parentFound: true,
      taskStatusEvents: [],
    });
    assert.equal(
      (await getTaskRunCreditState(db, "unfunded-child")).runtimeStatus,
      "FAILED",
    );
    assert.equal(
      (await getTaskRunCreditState(db, "unfunded-grandchild")).runtimeStatus,
      "UPSTREAM_FAILED",
    );
    await assertRuntimeInvariants(db);
  });

  test("queued children freeze exact parent Task Run dependencies and snapshots across later regeneration", async () => {
    const repository = createContractRepository();
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      id: "parent-approved-before-regeneration",
      nodeExecutionId: "node-execution-parent-freeze",
      nodeId: "source",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "asset-parent-before-regeneration",
      taskRunId: "parent-approved-before-regeneration",
      text: "old approved parent text",
    });
    const plan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        createNodeExecutionId: () => "node-execution-child-freeze",
        createTaskRunId: () => "child-freezes-parent",
        document: broadcastGeneratedTextDocument(),
        latestNodeExecutions: [
          { id: "node-execution-parent-freeze", nodeId: "source" },
        ],
        latestTaskRuns: [
          latestTaskRun({
            id: "parent-approved-before-regeneration",
            nodeExecutionId: "node-execution-parent-freeze",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-user",
        workflowId: "workflow-id",
      }),
    );

    await repository.commitWorkflowRunPlan(plan);
    const frozenDependencies = await getTaskDependenciesForChild(
      db,
      "child-freezes-parent",
    );
    const frozenState = await getTaskRunState(db, "child-freezes-parent");
    assert.equal(
      frozenDependencies[0]?.resolvedParentTaskRunId,
      "parent-approved-before-regeneration",
    );
    assert.equal(
      frozenState.inputSnapshot.resolvedParentTaskRuns[0]?.taskRunId,
      "parent-approved-before-regeneration",
    );

    await insertTaskRun(db, {
      attempt: 1,
      id: "parent-approved-after-regeneration",
      nodeExecutionId: "node-execution-parent-freeze",
      nodeId: "source",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "asset-parent-after-regeneration",
      taskRunId: "parent-approved-after-regeneration",
      text: "new approved parent text",
    });
    await repository.wakeUpTaskRunChildren({
      ownerUserId: "owner-user",
      settledParentTaskRunId: "parent-approved-after-regeneration",
    });

    assert.equal(
      (await getTaskRunCreditState(db, "parent-approved-before-regeneration"))
        .runtimeStatus,
      "APPROVED",
    );
    assert.deepEqual(
      await getTaskDependenciesForChild(db, "child-freezes-parent"),
      frozenDependencies,
    );
    assert.deepEqual(
      (await getTaskRunState(db, "child-freezes-parent")).inputSnapshot,
      frozenState.inputSnapshot,
    );
    await assertRuntimeInvariants(db);
  });

  test("broadcast and output-reorder materialization align Task Dependencies with provider snapshots", async () => {
    const repository = createContractRepository();
    await insertUser(db, { creditBalance: 100 });
    await insertTaskRun(db, {
      id: "broadcast-source-approved",
      nodeExecutionId: "node-execution-broadcast-source",
      nodeId: "source",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "asset-broadcast-source",
      taskRunId: "broadcast-source-approved",
      text: "broadcast prompt",
    });
    const broadcastLatestTaskRuns = [
      latestTaskRun({
        id: "broadcast-source-approved",
        nodeExecutionId: "node-execution-broadcast-source",
        status: "APPROVED",
      }),
    ];
    const broadcastPlan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        createNodeExecutionId: () => "node-execution-broadcast-script",
        createTaskRunId: nextId("broadcast-script-task"),
        document: broadcastGeneratedTextDocument(),
        latestNodeExecutions: [
          { id: "node-execution-broadcast-source", nodeId: "source" },
        ],
        latestTaskRuns: broadcastLatestTaskRuns,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { script: 3, source: 1 },
        workflowId: "workflow-id",
      }),
    );
    assertPlanInvariants(
      broadcastPlan,
      broadcastGeneratedTextDocument(),
      broadcastLatestTaskRuns,
    );
    assert.deepEqual(
      broadcastPlan.taskDependenciesToCreate.map((dependency) => ({
        childTaskRunId: dependency.childTaskRunId,
        parentItemIndex: dependency.parentItemIndex,
        parentNodeId: dependency.parentNodeId,
      })),
      [
        {
          childTaskRunId: "broadcast-script-task-1",
          parentItemIndex: 0,
          parentNodeId: "source",
        },
        {
          childTaskRunId: "broadcast-script-task-2",
          parentItemIndex: 0,
          parentNodeId: "source",
        },
        {
          childTaskRunId: "broadcast-script-task-3",
          parentItemIndex: 0,
          parentNodeId: "source",
        },
      ],
    );
    await repository.commitWorkflowRunPlan(broadcastPlan);
    for (const taskRunId of [
      "broadcast-script-task-1",
      "broadcast-script-task-2",
      "broadcast-script-task-3",
    ]) {
      const state = await getTaskRunState(db, taskRunId);
      assert.equal(providerPrompt(state.inputSnapshot), "broadcast prompt");
      assert.equal(
        state.inputSnapshot.resolvedParentTaskRuns[0]?.taskRunId,
        "broadcast-source-approved",
      );
    }

    await resetRuntimeContractTables(db);
    await insertUser(db, { creditBalance: 100 });
    for (const [itemIndex, text] of ["first", "second"].entries()) {
      const taskRunId = `reorder-source-approved-${itemIndex}`;
      await insertTaskRun(db, {
        id: taskRunId,
        itemIndex,
        nodeExecutionId: "node-execution-reorder-source",
        nodeId: "source",
        runtimeStatus: "APPROVED",
      });
      await insertGeneratedTextAsset(db, {
        assetId: `asset-${taskRunId}`,
        taskRunId,
        text,
      });
    }
    await setNodeExecutionOutputCount(db, {
      nodeExecutionId: "node-execution-reorder-source",
      outputCount: 2,
    });
    const reorderLatestTaskRuns = [
      latestTaskRun({
        id: "reorder-source-approved-0",
        itemIndex: 0,
        nodeExecutionId: "node-execution-reorder-source",
        status: "APPROVED",
      }),
      latestTaskRun({
        id: "reorder-source-approved-1",
        itemIndex: 1,
        nodeExecutionId: "node-execution-reorder-source",
        status: "APPROVED",
      }),
    ];
    const reorderPlan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        createNodeExecutionId: () => "node-execution-reorder-script",
        createTaskRunId: nextId("reorder-script-task"),
        document: outputReorderDocument(),
        latestNodeExecutions: [
          { id: "node-execution-reorder-source", nodeId: "source" },
        ],
        latestTaskRuns: reorderLatestTaskRuns,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { script: 2, source: 2 },
        workflowId: "workflow-id",
      }),
    );
    assertPlanInvariants(
      reorderPlan,
      outputReorderDocument(),
      reorderLatestTaskRuns,
    );
    assert.deepEqual(
      reorderPlan.taskDependenciesToCreate.map(
        (dependency) => dependency.parentItemIndex,
      ),
      [1, 0],
    );
    await repository.commitWorkflowRunPlan(reorderPlan);
    assert.equal(
      providerPrompt(
        (await getTaskRunState(db, "reorder-script-task-1")).inputSnapshot,
      ),
      "second",
    );
    assert.equal(
      providerPrompt(
        (await getTaskRunState(db, "reorder-script-task-2")).inputSnapshot,
      ),
      "first",
    );
    await assertRuntimeInvariants(db);
  });

  test("duplicate active commands are rejected and active-slot uniqueness is enforced durably", async () => {
    const document = simpleScriptDocument();
    assert.equal(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document,
        latestNodeExecutions: [
          { id: "node-execution-active-script", nodeId: "script" },
        ],
        latestTaskRuns: [
          latestTaskRun({
            id: "active-script-task",
            nodeExecutionId: "node-execution-active-script",
            status: "QUEUED",
          }),
        ],
        ownerId: "owner-user",
        workflowId: "workflow-id",
      }).ok,
      false,
    );
    assert.equal(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document,
        latestNodeExecutions: [
          { id: "node-execution-active-script", nodeId: "script" },
        ],
        latestTaskRuns: [
          latestTaskRun({
            id: "active-script-task",
            nodeExecutionId: "node-execution-active-script",
            status: "PENDING_REVIEW",
          }),
        ],
        ownerId: "owner-user",
        workflowId: "workflow-id",
      }).ok,
      false,
    );

    await insertTaskRun(db, {
      id: "active-slot-original",
      nodeExecutionId: "node-execution-active-slot",
      runtimeStatus: "QUEUED",
    });
    await assert.rejects(() =>
      insertTaskRun(db, {
        attempt: 1,
        id: "active-slot-duplicate",
        nodeExecutionId: "node-execution-active-slot",
        runtimeStatus: "RUNNING",
      }),
    );
    await assertRuntimeInvariants(db);
  });

  test("settled generated text and image Assets are workflow-local, task-run-linked, and renderable in events", async () => {
    const repository = createContractRepository();
    await insertTaskRun(db, {
      id: "text-producing-task",
      nodeExecutionId: "node-execution-text-producing",
      runtimeStatus: "RUNNING",
    });
    await insertTaskRun(db, {
      id: "image-producing-task",
      nodeExecutionId: "node-execution-image-producing",
      runtimeStatus: "RUNNING",
    });

    const text = await repository.settleTaskRunCompletion({
      attempt: 0,
      providerCostCredits: 0,
      generatedAsset: generatedTextAsset("asset-generated-text", "render me"),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskRunId: "text-producing-task",
    });
    const image = await repository.settleTaskRunCompletion({
      attempt: 0,
      providerCostCredits: 0,
      generatedAsset: generatedImageAsset("asset-generated-image"),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskRunId: "image-producing-task",
    });

    assert.equal(text.settled, true);
    assert.equal(image.settled, true);
    assert.deepEqual(text.settled ? text.event.output : null, {
      assetId: "asset-generated-text",
      kind: "inline-text-asset",
      text: "render me",
    });
    assert.deepEqual(image.settled ? image.event.output : null, {
      assetId: "asset-generated-image",
      cdnUrl: "https://cdn.example.com/asset-generated-image.png",
      contentType: "image/png",
      kind: "cdn-asset",
    });
    assert.deepEqual(await getAssetsForTaskRun(db, "text-producing-task"), [
      {
        cdnUrl: null,
        id: "asset-generated-text",
        kind: "text",
        mimeType: "text/plain",
        ownerUserId: "owner-user",
        source: "generated",
        taskRunId: "text-producing-task",
        text: "render me",
        workflowId: "workflow-id",
      },
    ]);
    assert.deepEqual(await getAssetsForTaskRun(db, "image-producing-task"), [
      {
        cdnUrl: "https://cdn.example.com/asset-generated-image.png",
        id: "asset-generated-image",
        kind: "image",
        mimeType: "image/png",
        ownerUserId: "owner-user",
        source: "generated",
        taskRunId: "image-producing-task",
        text: null,
        workflowId: "workflow-id",
      },
    ]);

    await insertGeneratedMediaAsset(db, {
      assetId: "asset-direct-fixture",
      taskRunId: "image-producing-task",
    });
    await assertRuntimeInvariants(db);
  });
});

function never(): never {
  throw new Error("Expected settled result");
}

function nonRefundableProviderFailureSource() {
  return {
    taskRunDebitRefundable: false,
    type: "PROVIDER" as const,
  };
}

function providerPrompt(snapshot: TaskRunInputSnapshot) {
  assert.equal(snapshot.providerInput.kind, "llm-generation-request");
  return snapshot.providerInput.kind === "llm-generation-request"
    ? snapshot.providerInput.request.prompt
    : null;
}
