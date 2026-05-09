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
  getAssetsForTask,
  getTaskCreditState,
  getTaskDependenciesForChild,
  getTaskState,
  getUserCreditBalance,
  insertGeneratedMediaAsset,
  insertGeneratedTextAsset,
  insertNodeRun,
  insertTask,
  insertTaskDependency,
  insertUser,
  latestTask,
  nextId,
  outputReorderDocument,
  type RuntimeContractDatabase,
  resetRuntimeContractTables,
  setNodeRunOutputCount,
  setUserCreditBalance,
  setupRuntimeContractTables,
  simpleScriptDocument,
  unwrapPlan,
} from "~/features/runtime/contract-harness";
import {
  isTaskInputSnapshot,
  type TaskInputSnapshot,
} from "~/features/runtime/execution/task-input-snapshot";
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
import { getTaskProjectionForWorkflow } from "~/features/runtime/server/task-projection-repository";
import { applyTaskStudioProjection } from "~/features/runtime/task-studio-projection";
import type { WorkflowDocument } from "~/features/workflow/document";
import { WorkflowValidationError } from "~/features/workflow/errors";
import { assertActiveTaskSaveAllowed } from "~/features/workflow/save-lock-policy";
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
    approveTask: (
      command: Omit<Parameters<typeof repository.approveTask>[0], "workflowId">,
    ) =>
      ServerTestRuntime.runPromise(
        repository.approveTask({ ...command, workflowId: "workflow-id" }),
      ).then((outcome) => outcome.value),
    cancelTask: (
      command: Omit<Parameters<typeof repository.cancelTask>[0], "workflowId">,
    ) =>
      ServerTestRuntime.runPromise(
        repository.cancelTask({ ...command, workflowId: "workflow-id" }),
      ).then((outcome) => outcome.value),
    claimQueuedTask: (
      command: Parameters<typeof repository.claimQueuedTask>[0],
    ) => ServerTestRuntime.runPromise(repository.claimQueuedTask(command)),
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
    rejectTaskAndCreateRegeneration: (
      command: Parameters<
        typeof repository.rejectTaskAndCreateRegeneration
      >[0] extends infer T
        ? Omit<T, "workflowId">
        : never,
    ) =>
      ServerTestRuntime.runPromise(
        repository.rejectTaskAndCreateRegeneration({
          ...command,
          workflowId: "workflow-id",
        }),
      ).then((outcome) => outcome.value),
    settleTaskCompletion: (
      command: Omit<
        Parameters<typeof repository.settleTaskCompletion>[0],
        "workflowId"
      >,
    ) =>
      ServerTestRuntime.runPromise(
        repository.settleTaskCompletion({
          ...command,
          workflowId: "workflow-id",
        }),
      ).then((outcome) => outcome.value),
    settleTaskFailure: (
      command: Omit<
        Parameters<typeof repository.settleTaskFailure>[0],
        "workflowId"
      >,
    ) =>
      ServerTestRuntime.runPromise(
        repository.settleTaskFailure({
          ...command,
          workflowId: "workflow-id",
        }),
      ).then((outcome) => outcome.value),
    wakeUpTaskChildren: (
      command: Omit<
        Parameters<typeof repository.wakeUpTaskChildren>[0],
        "workflowId"
      >,
    ) =>
      ServerTestRuntime.runPromise(
        repository.wakeUpTaskChildren({
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
    const layer = RuntimeCommands.Test.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RuntimeRepository, repository),
          Layer.succeed(RuntimeIdGenerator, {
            createNodeRunId: nextId("node-execution"),
            createTaskId: nextId("task-run"),
          }),
          Layer.succeed(RuntimePostCommitWork, {
            deliver: (work) =>
              Effect.promise(async () => {
                delivered.push(work);
                for (const job of work.executionJobs) {
                  const task = await getTaskState(db, job.taskId);
                  assert.equal(task.runtimeStatus, "QUEUED");
                }
                for (const event of work.taskStatusEvents) {
                  const task = await getTaskState(db, event.taskId);
                  assert.equal(task.runtimeStatus, event.status);
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
          latestNodeRuns: [],
          latestTasks: [],
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

  test("planner run-node contract creates upstream closure, reuses durable batches, waits on active parents, and never creates empty executable Node Runs", () => {
    const document = generatedImageToGeneratedVideoDocument();
    const firstRunLatestTasks: ReturnType<typeof latestTask>[] = [];
    const firstRun = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeRunId: nextId("node-execution"),
        createTaskId: nextId("task-run"),
        document,
        documentRevision: 12,
        latestNodeRuns: [],
        latestTasks: firstRunLatestTasks,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 2, video: 2 },
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(
      firstRun.nodeRunsToCreate.map((execution) => execution.nodeId),
      ["image", "video"],
    );
    assert.deepEqual(
      firstRun.tasksToCreate.map((task) => ({
        branchIndex: task.branchIndex,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        { branchIndex: 0, nodeId: "image", status: "QUEUED" },
        { branchIndex: 1, nodeId: "image", status: "QUEUED" },
        {
          branchIndex: 0,
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
        {
          branchIndex: 1,
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assertPlanInvariants(firstRun, document, firstRunLatestTasks);

    const activeUpstreamLatestTasks = [
      latestTask({
        id: "image-running-0",
        nodeRunId: "image-execution",
        status: "RUNNING",
      }),
      latestTask({
        id: "image-pending-1",
        branchIndex: 1,
        nodeRunId: "image-execution",
        status: "PENDING_REVIEW",
      }),
    ];
    const activeUpstreamRun = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeRunId: nextId("node-execution-active"),
        createTaskId: nextId("task-run-active"),
        document,
        latestNodeRuns: [{ id: "image-execution", nodeId: "image" }],
        latestTasks: activeUpstreamLatestTasks,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 2, video: 2 },
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(activeUpstreamRun.nodeRunsToReuse, [
      { id: "image-execution", nodeId: "image" },
    ]);
    assert.deepEqual(
      activeUpstreamRun.tasksToCreate.map((task) => ({
        branchIndex: task.branchIndex,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        { branchIndex: 0, nodeId: "video", status: "WAITING_UPSTREAM" },
        { branchIndex: 1, nodeId: "video", status: "WAITING_UPSTREAM" },
      ],
    );
    assertPlanInvariants(
      activeUpstreamRun,
      document,
      activeUpstreamLatestTasks,
    );

    const recoverableUpstreamLatestTasks = [
      latestTask({
        id: "image-failed-0",
        nodeRunId: "image-execution",
        status: "FAILED",
      }),
      latestTask({
        id: "image-cancelled-1",
        branchIndex: 1,
        nodeRunId: "image-execution",
        status: "CANCELLED",
      }),
    ];
    const recoverableUpstreamRun = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeRunId: nextId("node-execution-recover"),
        createTaskId: nextId("task-run-recover"),
        document,
        latestNodeRuns: [{ id: "image-execution", nodeId: "image" }],
        latestTasks: recoverableUpstreamLatestTasks,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 2, video: 2 },
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(
      recoverableUpstreamRun.tasksToCreate.map((task) => ({
        branchIndex: task.branchIndex,
        nodeRunId: task.nodeRunId,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        {
          branchIndex: 0,
          nodeRunId: "image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          branchIndex: 1,
          nodeRunId: "image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          branchIndex: 0,
          nodeRunId: "node-execution-recover-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
        {
          branchIndex: 1,
          nodeRunId: "node-execution-recover-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assertPlanInvariants(
      recoverableUpstreamRun,
      document,
      recoverableUpstreamLatestTasks,
    );

    const reviewBarrierLatestTasks = [
      latestTask({
        id: "image-pending-latest",
        nodeRunId: "image-execution",
        status: "PENDING_REVIEW",
      }),
    ];
    const reviewBarrierRun = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        document,
        latestNodeRuns: [{ id: "image-execution", nodeId: "image" }],
        latestTasks: reviewBarrierLatestTasks,
        ownerId: "owner-user",
        workflowId: "workflow-id",
      }),
    );
    assert.equal(reviewBarrierRun.tasksToCreate[0]?.status, "WAITING_UPSTREAM");
    assertPlanInvariants(reviewBarrierRun, document, reviewBarrierLatestTasks);
  });

  test("planner run-node contract fills empty reused upstream Node Run slots before children wait on them", () => {
    const document = generatedImageToGeneratedVideoDocument();
    const latestTasks: ReturnType<typeof latestTask>[] = [];
    const plan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeRunId: nextId("runtime-node-execution-run-node-empty-parent"),
        createTaskId: nextId("runtime-task-run-run-node-empty-parent"),
        document,
        latestNodeRuns: [{ id: "empty-image-execution", nodeId: "image" }],
        latestTasks,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 2, video: 2 },
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(plan.nodeRunsToReuse, [
      { id: "empty-image-execution", nodeId: "image" },
    ]);
    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        branchIndex: task.branchIndex,
        nodeRunId: task.nodeRunId,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        {
          branchIndex: 0,
          nodeRunId: "empty-image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          branchIndex: 1,
          nodeRunId: "empty-image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          branchIndex: 0,
          nodeRunId: "runtime-node-execution-run-node-empty-parent-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
        {
          branchIndex: 1,
          nodeRunId: "runtime-node-execution-run-node-empty-parent-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assert.deepEqual(
      plan.taskDependenciesToCreate.map((dependency) => ({
        childNodeId: dependency.childNodeId,
        parentBranchIndex: dependency.parentBranchIndex,
        parentNodeRunId: dependency.parentNodeRunId,
        parentNodeId: dependency.parentNodeId,
      })),
      [
        {
          childNodeId: "video",
          parentBranchIndex: 0,
          parentNodeRunId: "empty-image-execution",
          parentNodeId: "image",
        },
        {
          childNodeId: "video",
          parentBranchIndex: 1,
          parentNodeRunId: "empty-image-execution",
          parentNodeId: "image",
        },
      ],
    );
    assertPlanInvariants(plan, document, latestTasks);
  });

  test("planner run-node contract fills empty reused upstream Node Run slots before children wait on them", () => {
    const document = generatedImageToGeneratedVideoDocument();
    const latestTasks: ReturnType<typeof latestTask>[] = [];
    const plan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeRunId: nextId("runtime-node-execution-empty-parent"),
        createTaskId: nextId("runtime-task-run-empty-parent"),
        document,
        latestNodeRuns: [{ id: "empty-image-execution", nodeId: "image" }],
        latestTasks,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 2, video: 2 },
        workflowId: "workflow-id",
      }),
    );

    assert.deepEqual(plan.nodeRunsToReuse, [
      { id: "empty-image-execution", nodeId: "image" },
    ]);
    assert.deepEqual(
      plan.tasksToCreate.map((task) => ({
        branchIndex: task.branchIndex,
        nodeRunId: task.nodeRunId,
        nodeId: task.nodeId,
        status: task.status,
      })),
      [
        {
          branchIndex: 0,
          nodeRunId: "empty-image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          branchIndex: 1,
          nodeRunId: "empty-image-execution",
          nodeId: "image",
          status: "QUEUED",
        },
        {
          branchIndex: 0,
          nodeRunId: "runtime-node-execution-empty-parent-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
        {
          branchIndex: 1,
          nodeRunId: "runtime-node-execution-empty-parent-1",
          nodeId: "video",
          status: "WAITING_UPSTREAM",
        },
      ],
    );
    assertPlanInvariants(plan, document, latestTasks);
  });

  test("repository and gatekeeper contract commits materialized Tasks, gates review, freezes dependencies, and keeps Wake-Up Calls idempotent", async () => {
    const repository = createContractRepository();
    await insertUser(db, { creditBalance: 100 });
    const document = generatedImageToGeneratedVideoDocument();
    const plan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "video" },
        createNodeRunId: nextId("runtime-node-execution"),
        createTaskId: nextId("runtime-task-run"),
        document,
        documentRevision: 44,
        latestNodeRuns: [],
        latestTasks: [],
        ownerId: "owner-user",
        plannedItemCountByNodeId: { image: 1, video: 1 },
        workflowId: "workflow-id",
      }),
    );

    const commit = await repository.commitWorkflowRunPlan(plan);
    assert.deepEqual(
      commit.executionJobs.map((job) => job.jobId),
      ["task~runtime-task-run-1~execute"],
    );
    assertNoColonJobIds(commit.executionJobs, commit.wakeUpJobs);
    assert.deepEqual(commit.taskStatusEvents.map(eventContract), [
      {
        branchIndex: 0,
        nodeRunId: "runtime-node-execution-1",
        status: "QUEUED",
        taskId: "runtime-task-run-1",
      },
      {
        branchIndex: 0,
        nodeRunId: "runtime-node-execution-2",
        status: "WAITING_UPSTREAM",
        taskId: "runtime-task-run-2",
      },
    ]);
    assert.equal(await getUserCreditBalance(db, "owner-user"), 90);
    assert.deepEqual(await getTaskCreditState(db, "runtime-task-run-2"), {
      creditCost: 40,
      failureReason: null,
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await assertRuntimeInvariants(db);

    const claimed = await repository.claimQueuedTask({
      ownerUserId: "owner-user",
      taskId: "runtime-task-run-1",
    });
    assert.equal(claimed.claimed, true);
    if (!claimed.claimed) throw new Error("Expected queued image Task claim");
    assert.equal(
      claimed.inputSnapshot.providerInput.kind,
      "image-generation-request",
    );

    const pendingReview = await repository.settleTaskCompletion({
      providerCostCredits: 6,
      generatedAsset: generatedImageAsset("image-asset-pending"),
      ownerUserId: "owner-user",
      reviewRequired: true,
      taskId: "runtime-task-run-1",
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
      (await getTaskCreditState(db, "runtime-task-run-2")).runtimeStatus,
      "WAITING_UPSTREAM",
    );

    const approved = await repository.approveTask({
      ownerUserId: "owner-user",
      taskId: "runtime-task-run-1",
    });
    assert.deepEqual(approved, {
      decided: true,
      event: {
        branchIndex: 0,
        nodeRunId: "runtime-node-execution-1",
        status: "APPROVED",
        taskId: "runtime-task-run-1",
      },
      wakeUpJob: {
        jobId: "wake-up~runtime-task-run-1",
        ownerUserId: "owner-user",
        parentTaskId: "runtime-task-run-1",
        workflowId: "workflow-id",
      },
    });
    assertNoColonJobIds([approved.wakeUpJob]);

    const wake = await repository.wakeUpTaskChildren({
      ownerUserId: "owner-user",
      settledParentTaskId: "runtime-task-run-1",
    });
    assert.deepEqual(
      wake.executionJobs.map((job) => job.jobId),
      ["task~runtime-task-run-2~execute"],
    );
    assert.deepEqual(wake.taskStatusEvents.map(eventContract), [
      {
        branchIndex: 0,
        nodeRunId: "runtime-node-execution-2",
        status: "QUEUED",
        taskId: "runtime-task-run-2",
      },
    ]);
    assertNoColonJobIds(wake.executionJobs);
    assert.equal(await getUserCreditBalance(db, "owner-user"), 50);
    assert.deepEqual(await getTaskCreditState(db, "runtime-task-run-2"), {
      creditCost: 40,
      failureReason: null,
      runtimeStatus: "QUEUED",
    });
    const duplicateWake = await repository.wakeUpTaskChildren({
      ownerUserId: "owner-user",
      settledParentTaskId: "runtime-task-run-1",
    });
    assert.deepEqual(duplicateWake, {
      executionJobs: [],
      parentFound: true,
      taskStatusEvents: [],
    });
    assert.equal(await getUserCreditBalance(db, "owner-user"), 50);

    const dependencies = await repository.getTaskDependenciesForChild({
      childTaskId: "runtime-task-run-2",
    });
    assert.equal(dependencies[0]?.resolvedParentTaskId, "runtime-task-run-1");
    const child = await getTaskState(db, "runtime-task-run-2");
    assert.equal(isTaskInputSnapshot(child.inputSnapshot), true);
    if (!isTaskInputSnapshot(child.inputSnapshot)) {
      throw new Error("Expected queued child input snapshot");
    }
    assert.equal(child.inputSnapshot.documentRevision, 44);
    assert.equal(
      child.inputSnapshot.providerInput.kind,
      "video-generation-request",
    );
    assert.equal(
      child.inputSnapshot.resolvedParentTasks[0]?.taskId,
      "runtime-task-run-1",
    );
    await assertRuntimeInvariants(db);
  });

  test("Task replacement contract distinguishes rejection, cancellation, failure, regeneration, rerun, and explicit recovery", async () => {
    const repository = createContractRepository();
    await insertUser(db, { creditBalance: 60 });
    await insertTask(db, {
      creditCost: 5,
      id: "review-task-original",
      nodeRunId: "node-execution-review",
      runtimeStatus: "PENDING_REVIEW",
    });

    const rejected = await repository.rejectTaskAndCreateRegeneration({
      newTaskId: "review-task-regenerated",
      ownerUserId: "owner-user",
      taskId: "review-task-original",
    });
    assert.equal(rejected.rejected, true);
    assert.deepEqual(
      rejected.rejected ? rejected.taskStatusEvents.map(eventContract) : [],
      [
        {
          branchIndex: 0,
          nodeRunId: "node-execution-review",
          status: "REJECTED",
          taskId: "review-task-original",
        },
        {
          branchIndex: 0,
          nodeRunId: "node-execution-review",
          status: "QUEUED",
          taskId: "review-task-regenerated",
        },
      ],
    );
    assert.equal(
      (await getTaskCreditState(db, "review-task-original")).runtimeStatus,
      "REJECTED",
    );
    assert.equal(
      (await getTaskCreditState(db, "review-task-regenerated")).runtimeStatus,
      "QUEUED",
    );

    await insertTask(db, {
      id: "cancelled-parent",
      nodeRunId: "node-execution-cancel-parent",
      runtimeStatus: "QUEUED",
    });
    await insertTask(db, {
      id: "waiting-child-of-cancelled",
      nodeRunId: "node-execution-child-of-cancelled",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskId: "waiting-child-of-cancelled",
      parentNodeRunId: "node-execution-cancel-parent",
    });
    await repository.cancelTask({
      ownerUserId: "owner-user",
      taskId: "cancelled-parent",
    });
    await repository.wakeUpTaskChildren({
      ownerUserId: "owner-user",
      settledParentTaskId: "cancelled-parent",
    });
    assert.equal(
      (await getTaskCreditState(db, "cancelled-parent")).runtimeStatus,
      "CANCELLED",
    );
    assert.equal(
      (await getTaskCreditState(db, "waiting-child-of-cancelled"))
        .runtimeStatus,
      "UPSTREAM_FAILED",
    );

    await insertUser(db, { creditBalance: 3, id: "low-credit-user" });
    await insertTask(db, {
      creditCost: 10,
      id: "unfunded-parent",
      nodeRunId: "node-execution-unfunded-parent",
      ownerUserId: "low-credit-user",
      runtimeStatus: "RUNNING",
    });
    await insertTask(db, {
      id: "waiting-child-of-unfunded",
      nodeRunId: "node-execution-child-of-unfunded",
      ownerUserId: "low-credit-user",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskId: "waiting-child-of-unfunded",
      parentNodeRunId: "node-execution-unfunded-parent",
    });
    await repository.settleTaskFailure({
      failureReason: { message: "provider failed", type: "PROVIDER_FAILED" },
      failureSource: nonRefundableProviderFailureSource(),
      ownerUserId: "low-credit-user",
      taskId: "unfunded-parent",
    });
    await repository.wakeUpTaskChildren({
      ownerUserId: "low-credit-user",
      settledParentTaskId: "unfunded-parent",
    });
    assert.equal(
      (await getTaskCreditState(db, "waiting-child-of-unfunded")).runtimeStatus,
      "UPSTREAM_FAILED",
    );

    const document = simpleScriptDocument();
    const regenerate = unwrapPlan(
      planWorkflowRun({
        command: {
          branchIndex: 1,
          nodeRunId: "node-execution-script-existing",
          type: "run-task",
        },
        document,
        latestNodeRuns: [
          { id: "node-execution-script-existing", nodeId: "script" },
        ],
        latestTasks: [
          latestTask({
            id: "script-item-0-approved",
            branchIndex: 0,
            nodeRunId: "node-execution-script-existing",
            status: "APPROVED",
          }),
          latestTask({
            id: "script-item-1-cancelled",
            branchIndex: 1,
            nodeRunId: "node-execution-script-existing",
            status: "CANCELLED",
          }),
        ],
        ownerId: "owner-user",
        plannedItemCountByNodeId: { script: 2 },
        workflowId: "workflow-id",
      }),
    );
    assert.deepEqual(
      regenerate.tasksToCreate.map((task) => ({
        branchIndex: task.branchIndex,
        nodeRunId: task.nodeRunId,
      })),
      [
        {
          branchIndex: 1,
          nodeRunId: "node-execution-script-existing",
        },
      ],
    );
    const rerun = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        document,
        latestNodeRuns: [
          { id: "node-execution-script-existing", nodeId: "script" },
        ],
        latestTasks: [
          latestTask({
            id: "script-item-1-approved",
            branchIndex: 1,
            nodeRunId: "node-execution-script-existing",
            status: "APPROVED",
          }),
        ],
        ownerId: "owner-user",
        plannedItemCountByNodeId: { script: 2 },
        workflowId: "workflow-id",
      }),
    );
    assert.notEqual(
      rerun.nodeRunsToCreate[0]?.id,
      "node-execution-script-existing",
    );
    assert.deepEqual(
      rerun.tasksToCreate.map((task) => ({
        branchIndex: task.branchIndex,
      })),
      [{ branchIndex: 0 }, { branchIndex: 1 }],
    );
    await assertRuntimeInvariants(db);
  });

  test("materialized snapshot, provider, queue, projection, and save-lock consumers obey the runtime contract", async () => {
    const jobPayloads = [
      buildRuntimeExecutionJobPayload({
        branchIndex: 1,
        nodeRunId: "node-execution-queue",
        ownerUserId: "owner-user",
        taskId: "task-run-queue",
        workflowId: "workflow-id",
      }),
      buildRuntimeCompletionSettlementJobPayload({
        providerCostCredits: 1,
        generatedAsset: generatedTextAsset("asset-queue", "done"),
        ownerUserId: "owner-user",
        reviewRequired: false,
        taskId: "task-run-queue",
        workflowId: "workflow-id",
      }),
      buildRuntimeFailureSettlementJobPayload({
        failureReason: { message: "failed", type: "PROVIDER_FAILED" },
        failureSource: nonRefundableProviderFailureSource(),
        ownerUserId: "owner-user",
        taskId: "task-run-queue",
        workflowId: "workflow-id",
      }),
      buildRuntimeWakeUpJobPayload({
        ownerUserId: "owner-user",
        parentTaskId: "task-run-queue",
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
      taskId: "task-run-provider",
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
      assertActiveTaskSaveAllowed({
        activeTargetNodeIds: ["active-generator"],
        currentDocument,
        nextDocument: movedWithRuntimePayloads,
      }),
    );
    assert.throws(
      () =>
        assertActiveTaskSaveAllowed({
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

    await insertNodeRun(db, {
      id: "node-execution-projection-old",
      nodeId: "projected-node",
    });
    await insertTask(db, {
      id: "projected-old-approved",
      nodeRunId: "node-execution-projection-old",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "projected-old-asset",
      taskId: "projected-old-approved",
      text: "stale text",
    });
    await insertTask(db, {
      failureReason: "PROVIDER_FAILED",
      id: "projected-latest-failed",
      nodeRunId: "node-execution-projection-old",
      nodeId: "projected-node",
      runtimeStatus: "FAILED",
    });
    const projection = await ServerTestRuntime.runPromise(
      getTaskProjectionForWorkflow({
        ownerUserId: "owner-user",
        workflowId: "workflow-id",
      }),
    );
    assert.deepEqual(projection, [
      {
        failureReason: "PROVIDER_FAILED",
        branchIndex: 0,
        nodeRunId: "node-execution-projection-old",
        nodeId: "projected-node",
        status: "FAILED",
        taskId: "projected-latest-failed",
      },
    ]);

    const studio = WorkflowEngine.addNode(
      WorkflowEngine.createInitialState(),
      "llmGenerator",
    );
    const nodeId = studio.document.nodes[0]?.id;
    assert.ok(nodeId);
    const projectedStudio = applyTaskStudioProjection({
      document: studio.document,
      runtime: studio.runtime,
      slots: [
        {
          branchIndex: 0,
          nodeRunId: "node-execution-studio",
          nodeId,
          output: {
            assetId: "studio-text",
            kind: "inline-text-asset",
            text: "draft",
          },
          status: "PENDING_REVIEW",
          taskId: "studio-task-run",
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
    await insertTask(db, {
      id: "parent-review-disabled",
      nodeRunId: "node-execution-parent-review-disabled",
      runtimeStatus: "RUNNING",
    });
    await insertTask(db, {
      id: "child-waits-on-review-disabled",
      nodeRunId: "node-execution-child-review-disabled",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskId: "child-waits-on-review-disabled",
      parentNodeRunId: "node-execution-parent-review-disabled",
    });

    const result = await repository.settleTaskCompletion({
      providerCostCredits: 4,
      generatedAsset: generatedTextAsset(
        "asset-review-disabled",
        "approved text",
      ),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskId: "parent-review-disabled",
    });

    assert.deepEqual(result, {
      event: {
        branchIndex: 0,
        nodeRunId: "node-execution-parent-review-disabled",
        output: {
          assetId: "asset-review-disabled",
          kind: "inline-text-asset",
          text: "approved text",
        },
        status: "APPROVED",
        taskId: "parent-review-disabled",
      },
      settled: true,
      wakeUpJob: {
        jobId: "wake-up~parent-review-disabled",
        ownerUserId: "owner-user",
        parentTaskId: "parent-review-disabled",
        workflowId: "workflow-id",
      },
    });
    assert.equal(
      (await getTaskCreditState(db, "parent-review-disabled")).runtimeStatus,
      "APPROVED",
    );
    assert.deepEqual(eventContract(result.settled ? result.event : never()), {
      branchIndex: 0,
      nodeRunId: "node-execution-parent-review-disabled",
      status: "APPROVED",
      taskId: "parent-review-disabled",
    });
    await assertRuntimeInvariants(db);
  });

  test("cancel command covers every cancellable and non-cancellable Task state", async () => {
    const repository = await createContractCommandRepository();
    const wakeUpJobs: ReturnType<typeof buildRuntimeWakeUpJobPayload>[] = [];
    const publishedEvents: ReturnType<typeof eventContract>[] = [];
    const layer = RuntimeCommands.Test.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(RuntimeRepository, repository),
          Layer.succeed(RuntimeIdGenerator, {
            createNodeRunId: nextId("node-execution"),
            createTaskId: nextId("task-run"),
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
    const runCancel = (taskId: string) =>
      Effect.runPromise(
        Effect.flatMap(RuntimeCommands, (commands) =>
          commands.cancelTask({
            ownerUserId: "owner-user",
            taskId,
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
    await insertTask(db, {
      creditCost: 12,
      id: "cancel-command-waiting",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTask(db, {
      creditCost: 12,
      id: "cancel-command-queued",
      runtimeStatus: "QUEUED",
    });
    await insertTask(db, {
      id: "cancel-command-running",
      runtimeStatus: "RUNNING",
    });
    await insertTask(db, {
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
      await insertTask(db, {
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
      _tag: "TaskCancellationBlockedError",
      committed: false,
      message: "Running Tasks cannot be cancelled.",
      reason: "RUNNING_TASK_RUN_CANCELLATION_BLOCKED",
    });
    assert.equal(pendingReview.ok, false);
    assert.deepEqual(pendingReview.ok ? null : pendingReview.error, {
      _tag: "TaskCancellationBlockedError",
      committed: false,
      message:
        "Pending Review Tasks must be approved or rejected instead of cancelled.",
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
        branchIndex: 0,
        nodeRunId: "node-execution-cancel-command-waiting",
        status: "CANCELLED",
        taskId: "cancel-command-waiting",
      },
      {
        branchIndex: 0,
        nodeRunId: "node-execution-cancel-command-queued",
        status: "CANCELLED",
        taskId: "cancel-command-queued",
      },
    ]);
    assert.deepEqual(
      wakeUpJobs.map((job) => job.parentTaskId),
      ["cancel-command-waiting", "cancel-command-queued"],
    );
    assert.deepEqual(await getTaskCreditState(db, "cancel-command-waiting"), {
      creditCost: 12,
      failureReason: null,
      runtimeStatus: "CANCELLED",
    });
    assert.deepEqual(await getTaskCreditState(db, "cancel-command-queued"), {
      creditCost: 12,
      failureReason: null,
      runtimeStatus: "CANCELLED",
    });
    assert.equal(
      (await getTaskCreditState(db, "cancel-command-running")).runtimeStatus,
      "RUNNING",
    );
    assert.equal(
      (await getTaskCreditState(db, "cancel-command-review")).runtimeStatus,
      "PENDING_REVIEW",
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 112);
    await assertRuntimeInvariants(db);
  });

  test("insufficient credits fail a ready child, cascade descendants, and later credits do not auto-resume", async () => {
    const repository = createContractRepository();
    await insertUser(db, { creditBalance: 5 });
    await insertTask(db, {
      id: "funded-parent-approved",
      nodeRunId: "node-execution-funded-parent",
      runtimeStatus: "APPROVED",
    });
    await insertTask(db, {
      creditCost: 20,
      id: "unfunded-child",
      nodeRunId: "node-execution-unfunded-child",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTask(db, {
      creditCost: 1,
      id: "unfunded-grandchild",
      nodeRunId: "node-execution-unfunded-grandchild",
      runtimeStatus: "WAITING_UPSTREAM",
    });
    await insertTaskDependency(db, {
      childTaskId: "unfunded-child",
      parentNodeRunId: "node-execution-funded-parent",
    });
    await insertTaskDependency(db, {
      childTaskId: "unfunded-grandchild",
      parentNodeRunId: "node-execution-unfunded-child",
    });

    assert.equal(
      (await getTaskCreditState(db, "unfunded-child")).creditCost,
      20,
    );
    const result = await repository.wakeUpTaskChildren({
      ownerUserId: "owner-user",
      settledParentTaskId: "funded-parent-approved",
    });

    assert.deepEqual(result.executionJobs, []);
    assert.deepEqual(result.taskStatusEvents.map(eventContract), [
      {
        branchIndex: 0,
        nodeRunId: "node-execution-unfunded-child",
        status: "FAILED",
        taskId: "unfunded-child",
      },
      {
        branchIndex: 0,
        nodeRunId: "node-execution-unfunded-grandchild",
        status: "UPSTREAM_FAILED",
        taskId: "unfunded-grandchild",
      },
    ]);
    assert.deepEqual(await getTaskCreditState(db, "unfunded-child"), {
      creditCost: 20,
      failureReason: "INSUFFICIENT_CREDITS",
      runtimeStatus: "FAILED",
    });
    assert.equal(
      (await getTaskCreditState(db, "unfunded-grandchild")).runtimeStatus,
      "UPSTREAM_FAILED",
    );
    assert.equal(await getUserCreditBalance(db, "owner-user"), 5);

    await setUserCreditBalance(db, { creditBalance: 100 });
    const duplicateWake = await repository.wakeUpTaskChildren({
      ownerUserId: "owner-user",
      settledParentTaskId: "funded-parent-approved",
    });
    assert.deepEqual(duplicateWake, {
      executionJobs: [],
      parentFound: true,
      taskStatusEvents: [],
    });
    assert.equal(
      (await getTaskCreditState(db, "unfunded-child")).runtimeStatus,
      "FAILED",
    );
    assert.equal(
      (await getTaskCreditState(db, "unfunded-grandchild")).runtimeStatus,
      "UPSTREAM_FAILED",
    );
    await assertRuntimeInvariants(db);
  });

  test("queued children freeze exact parent Task dependencies and snapshots across later regeneration", async () => {
    const repository = createContractRepository();
    await insertUser(db, { creditBalance: 100 });
    await insertTask(db, {
      id: "parent-approved-before-regeneration",
      nodeRunId: "node-execution-parent-freeze",
      nodeId: "source",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "asset-parent-before-regeneration",
      taskId: "parent-approved-before-regeneration",
      text: "old approved parent text",
    });
    const plan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        createNodeRunId: () => "node-execution-child-freeze",
        createTaskId: () => "child-freezes-parent",
        document: broadcastGeneratedTextDocument(),
        latestNodeRuns: [
          { id: "node-execution-parent-freeze", nodeId: "source" },
        ],
        latestTasks: [
          latestTask({
            id: "parent-approved-before-regeneration",
            nodeRunId: "node-execution-parent-freeze",
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
    const frozenState = await getTaskState(db, "child-freezes-parent");
    assert.equal(
      frozenDependencies[0]?.resolvedParentTaskId,
      "parent-approved-before-regeneration",
    );
    assert.equal(
      frozenState.inputSnapshot.resolvedParentTasks[0]?.taskId,
      "parent-approved-before-regeneration",
    );

    await insertTask(db, {
      id: "parent-approved-after-regeneration",
      nodeRunId: "node-execution-parent-freeze",
      nodeId: "source",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "asset-parent-after-regeneration",
      taskId: "parent-approved-after-regeneration",
      text: "new approved parent text",
    });
    await repository.wakeUpTaskChildren({
      ownerUserId: "owner-user",
      settledParentTaskId: "parent-approved-after-regeneration",
    });

    assert.equal(
      (await getTaskCreditState(db, "parent-approved-before-regeneration"))
        .runtimeStatus,
      "APPROVED",
    );
    assert.deepEqual(
      await getTaskDependenciesForChild(db, "child-freezes-parent"),
      frozenDependencies,
    );
    assert.deepEqual(
      (await getTaskState(db, "child-freezes-parent")).inputSnapshot,
      frozenState.inputSnapshot,
    );
    await assertRuntimeInvariants(db);
  });

  test("broadcast and output-reorder materialization align Task Dependencies with provider snapshots", async () => {
    const repository = createContractRepository();
    await insertUser(db, { creditBalance: 100 });
    await insertTask(db, {
      id: "broadcast-source-approved",
      nodeRunId: "node-execution-broadcast-source",
      nodeId: "source",
      runtimeStatus: "APPROVED",
    });
    await insertGeneratedTextAsset(db, {
      assetId: "asset-broadcast-source",
      taskId: "broadcast-source-approved",
      text: "broadcast prompt",
    });
    const broadcastLatestTasks = [
      latestTask({
        id: "broadcast-source-approved",
        nodeRunId: "node-execution-broadcast-source",
        status: "APPROVED",
      }),
    ];
    const broadcastPlan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        createNodeRunId: () => "node-execution-broadcast-script",
        createTaskId: nextId("broadcast-script-task"),
        document: broadcastGeneratedTextDocument(),
        latestNodeRuns: [
          { id: "node-execution-broadcast-source", nodeId: "source" },
        ],
        latestTasks: broadcastLatestTasks,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { script: 3, source: 1 },
        workflowId: "workflow-id",
      }),
    );
    assertPlanInvariants(
      broadcastPlan,
      broadcastGeneratedTextDocument(),
      broadcastLatestTasks,
    );
    assert.deepEqual(
      broadcastPlan.taskDependenciesToCreate.map((dependency) => ({
        childTaskId: dependency.childTaskId,
        parentBranchIndex: dependency.parentBranchIndex,
        parentNodeId: dependency.parentNodeId,
      })),
      [
        {
          childTaskId: "broadcast-script-task-1",
          parentBranchIndex: 0,
          parentNodeId: "source",
        },
        {
          childTaskId: "broadcast-script-task-2",
          parentBranchIndex: 0,
          parentNodeId: "source",
        },
        {
          childTaskId: "broadcast-script-task-3",
          parentBranchIndex: 0,
          parentNodeId: "source",
        },
      ],
    );
    await repository.commitWorkflowRunPlan(broadcastPlan);
    for (const taskId of [
      "broadcast-script-task-1",
      "broadcast-script-task-2",
      "broadcast-script-task-3",
    ]) {
      const state = await getTaskState(db, taskId);
      assert.equal(providerPrompt(state.inputSnapshot), "broadcast prompt");
      assert.equal(
        state.inputSnapshot.resolvedParentTasks[0]?.taskId,
        "broadcast-source-approved",
      );
    }

    await resetRuntimeContractTables(db);
    await insertUser(db, { creditBalance: 100 });
    for (const [branchIndex, text] of ["first", "second"].entries()) {
      const taskId = `reorder-source-approved-${branchIndex}`;
      await insertTask(db, {
        id: taskId,
        branchIndex,
        nodeRunId: "node-execution-reorder-source",
        nodeId: "source",
        runtimeStatus: "APPROVED",
      });
      await insertGeneratedTextAsset(db, {
        assetId: `asset-${taskId}`,
        taskId,
        text,
      });
    }
    await setNodeRunOutputCount(db, {
      nodeRunId: "node-execution-reorder-source",
      outputCount: 2,
    });
    const reorderLatestTasks = [
      latestTask({
        id: "reorder-source-approved-0",
        branchIndex: 0,
        nodeRunId: "node-execution-reorder-source",
        status: "APPROVED",
      }),
      latestTask({
        id: "reorder-source-approved-1",
        branchIndex: 1,
        nodeRunId: "node-execution-reorder-source",
        status: "APPROVED",
      }),
    ];
    const reorderPlan = unwrapPlan(
      planWorkflowRun({
        command: { type: "run-node", nodeId: "script" },
        createNodeRunId: () => "node-execution-reorder-script",
        createTaskId: nextId("reorder-script-task"),
        document: outputReorderDocument(),
        latestNodeRuns: [
          { id: "node-execution-reorder-source", nodeId: "source" },
        ],
        latestTasks: reorderLatestTasks,
        ownerId: "owner-user",
        plannedItemCountByNodeId: { script: 2, source: 2 },
        workflowId: "workflow-id",
      }),
    );
    assertPlanInvariants(
      reorderPlan,
      outputReorderDocument(),
      reorderLatestTasks,
    );
    assert.deepEqual(
      reorderPlan.taskDependenciesToCreate.map(
        (dependency) => dependency.parentBranchIndex,
      ),
      [1, 0],
    );
    await repository.commitWorkflowRunPlan(reorderPlan);
    assert.equal(
      providerPrompt(
        (await getTaskState(db, "reorder-script-task-1")).inputSnapshot,
      ),
      "second",
    );
    assert.equal(
      providerPrompt(
        (await getTaskState(db, "reorder-script-task-2")).inputSnapshot,
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
        latestNodeRuns: [
          { id: "node-execution-active-script", nodeId: "script" },
        ],
        latestTasks: [
          latestTask({
            id: "active-script-task",
            nodeRunId: "node-execution-active-script",
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
        latestNodeRuns: [
          { id: "node-execution-active-script", nodeId: "script" },
        ],
        latestTasks: [
          latestTask({
            id: "active-script-task",
            nodeRunId: "node-execution-active-script",
            status: "PENDING_REVIEW",
          }),
        ],
        ownerId: "owner-user",
        workflowId: "workflow-id",
      }).ok,
      false,
    );

    await insertTask(db, {
      id: "active-slot-original",
      nodeRunId: "node-execution-active-slot",
      runtimeStatus: "QUEUED",
    });
    await assert.rejects(() =>
      insertTask(db, {
        id: "active-slot-duplicate",
        nodeRunId: "node-execution-active-slot",
        runtimeStatus: "RUNNING",
      }),
    );
    await assertRuntimeInvariants(db);
  });

  test("settled generated text and image Assets are workflow-local, task-run-linked, and renderable in events", async () => {
    const repository = createContractRepository();
    await insertTask(db, {
      id: "text-producing-task",
      nodeRunId: "node-execution-text-producing",
      runtimeStatus: "RUNNING",
    });
    await insertTask(db, {
      id: "image-producing-task",
      nodeRunId: "node-execution-image-producing",
      runtimeStatus: "RUNNING",
    });

    const text = await repository.settleTaskCompletion({
      providerCostCredits: 0,
      generatedAsset: generatedTextAsset("asset-generated-text", "render me"),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskId: "text-producing-task",
    });
    const image = await repository.settleTaskCompletion({
      providerCostCredits: 0,
      generatedAsset: generatedImageAsset("asset-generated-image"),
      ownerUserId: "owner-user",
      reviewRequired: false,
      taskId: "image-producing-task",
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
    assert.deepEqual(await getAssetsForTask(db, "text-producing-task"), [
      {
        cdnUrl: null,
        id: "asset-generated-text",
        kind: "text",
        mimeType: "text/plain",
        ownerUserId: "owner-user",
        source: "generated",
        taskId: "text-producing-task",
        text: "render me",
        workflowId: "workflow-id",
      },
    ]);
    assert.deepEqual(await getAssetsForTask(db, "image-producing-task"), [
      {
        cdnUrl: "https://cdn.example.com/asset-generated-image.png",
        id: "asset-generated-image",
        kind: "image",
        mimeType: "image/png",
        ownerUserId: "owner-user",
        source: "generated",
        taskId: "image-producing-task",
        text: null,
        workflowId: "workflow-id",
      },
    ]);

    await insertGeneratedMediaAsset(db, {
      assetId: "asset-direct-fixture",
      taskId: "image-producing-task",
    });
    await assertRuntimeInvariants(db);
  });
});

function never(): never {
  throw new Error("Expected settled result");
}

function nonRefundableProviderFailureSource() {
  return {
    taskDebitRefundable: false,
    type: "PROVIDER" as const,
  };
}

function providerPrompt(snapshot: TaskInputSnapshot) {
  assert.equal(snapshot.providerInput.kind, "llm-generation-request");
  return snapshot.providerInput.kind === "llm-generation-request"
    ? snapshot.providerInput.request.prompt
    : null;
}
