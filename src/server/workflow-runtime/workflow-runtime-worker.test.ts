import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect } from "effect";

import {
  createWorkflowRuntimeProcessor,
  sweepQueuedTaskRunJobs,
  type WorkflowRuntimeJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-worker";

describe("WorkflowRuntimeWorker", () => {
  test("routes shared BullMQ queue jobs by job name", async () => {
    const executionWorker = new FakeExecutionWorker();
    const orchestrator = new FakeOrchestrator();
    const processor = createWorkflowRuntimeProcessor({
      executionWorker,
      orchestrator,
    });

    await processor(fakeJob("execute-task-run", executionJob()));
    await processor(fakeJob("settle-task-run-completion", completionJob()));
    await processor(fakeJob("settle-task-run-failure", failureJob()));
    await processor(fakeJob("wake-up-task-run-children", wakeUpJob()));

    assert.deepEqual(executionWorker.executed, [executionJob()]);
    assert.deepEqual(orchestrator.completions, [completionJob()]);
    assert.deepEqual(orchestrator.failures, [failureJob()]);
    assert.deepEqual(orchestrator.wakeUps, [
      {
        ownerUserId: "owner-1",
        settledParentTaskRunId: "parent-task-run-1",
        workflowId: "workflow-1",
      },
    ]);
  });

  test("rejects unknown shared queue job names", async () => {
    const processor = createWorkflowRuntimeProcessor({
      executionWorker: new FakeExecutionWorker(),
      orchestrator: new FakeOrchestrator(),
    });

    await assert.rejects(
      processor(fakeJob("unknown-job", executionJob())),
      /Unknown workflow runtime job name: unknown-job/,
    );
  });

  test("rejects mismatched job names and payloads before dispatch", async () => {
    const executionWorker = new FakeExecutionWorker();
    const orchestrator = new FakeOrchestrator();
    const processor = createWorkflowRuntimeProcessor({
      executionWorker,
      orchestrator,
    });

    await assert.rejects(
      processor(fakeJob("execute-task-run", wakeUpJob())),
      /WorkflowRuntimeJobDispatchError/,
    );
    assert.deepEqual(executionWorker.executed, []);
    assert.deepEqual(orchestrator.wakeUps, []);
  });

  test("returns sanitized orchestrator committed command outcomes", async () => {
    const orchestrator = new FakeOrchestrator({
      completionOutcome: {
        status: "committed" as const,
        value: {
          event: { type: "task-run-status-changed" },
          executionJob: { jobId: "execution-job-1" },
          executionJobs: [{ jobId: "execution-job-2" }],
          nested: {
            settledTaskRunId: "task-run-1",
            taskStatusEvents: [{ type: "task-run-status-changed" }],
            wakeUpJob: { jobId: "wake-up-job-1" },
            wakeUpJobs: [{ jobId: "wake-up-job-2" }],
          },
          settled: true as const,
          taskStatusEvents: [{ type: "task-run-status-changed" }],
        },
      },
    });
    const processor = createWorkflowRuntimeProcessor({
      executionWorker: new FakeExecutionWorker(),
      orchestrator,
    });

    const outcome = await processor(
      fakeJob("settle-task-run-completion", completionJob()),
    );

    assert.deepEqual(outcome, {
      status: "committed",
      value: {
        nested: { settledTaskRunId: "task-run-1" },
        settled: true,
      },
    });
    assertNoPostCommitTransportKeys(outcome);
  });

  test("returns orchestrator ignored command outcomes unchanged", async () => {
    const orchestrator = new FakeOrchestrator({
      wakeUpOutcome: {
        reason: "WAKE_UP_PARENT_NOT_FOUND" as const,
        status: "ignored" as const,
      },
    });
    const processor = createWorkflowRuntimeProcessor({
      executionWorker: new FakeExecutionWorker(),
      orchestrator,
    });

    assert.deepEqual(
      await processor(fakeJob("wake-up-task-run-children", wakeUpJob())),
      {
        reason: "WAKE_UP_PARENT_NOT_FOUND",
        status: "ignored",
      },
    );
  });

  test("rejects Wake-Up Call handling failures so BullMQ can retry", async () => {
    const wakeUpError = new Error("database unavailable");
    const processor = createWorkflowRuntimeProcessor({
      executionWorker: new FakeExecutionWorker(),
      orchestrator: new FakeOrchestrator({ wakeUpError }),
    });

    await assert.rejects(
      processor(fakeJob("wake-up-task-run-children", wakeUpJob())),
      wakeUpError,
    );
  });

  test("re-enqueues durable queued Task Runs idempotently", async () => {
    const repository = new FakeQueuedTaskRunRepository([
      executionJob("task-run-1", 0),
      executionJob("task-run-2", 1),
    ]);
    const queue = new FakeExecutionQueue();

    const result = await sweepQueuedTaskRunJobs({
      limit: 50,
      queue,
      repository,
    });

    assert.deepEqual(result, { enqueued: 2 });
    assert.deepEqual(repository.commands, [{ limit: 50 }]);
    assert.deepEqual(queue.enqueued, [
      executionJob("task-run-1", 0),
      executionJob("task-run-2", 1),
    ]);
  });
});

function fakeJob(name: string, data: WorkflowRuntimeJobPayload) {
  return { data, name };
}

function assertNoPostCommitTransportKeys(value: unknown) {
  const serialized = JSON.stringify(value);
  assert.ok(serialized);
  for (const key of [
    "event",
    "executionJob",
    "executionJobs",
    "taskStatusEvents",
    "wakeUpJob",
    "wakeUpJobs",
  ]) {
    assert.equal(serialized.includes(key), false, key);
  }
}

function executionJob(taskRunId = "task-run-1", attempt = 0) {
  return {
    attempt,
    itemIndex: attempt,
    jobId: `task-run~${taskRunId}~attempt~${attempt}~execute`,
    nodeExecutionId: `node-execution-${attempt}`,
    ownerUserId: "owner-1",
    taskRunId,
    workflowId: "workflow-1",
  };
}

function completionJob() {
  return {
    attempt: 0,
    providerCostCredits: 2,
    generatedAsset: {
      assetId: "asset-1",
      contentType: "text/plain",
      fileName: "asset.txt",
      kind: "text" as const,
      sizeBytes: 5,
      storageProvider: "inline",
      text: "hello",
    },
    jobId: "task-run~task-run-1~attempt~0~orchestrator~completion",
    ownerUserId: "owner-1",
    reviewRequired: false,
    taskRunId: "task-run-1",
    workflowId: "workflow-1",
  };
}

function failureJob() {
  return {
    attempt: 0,
    failureReason: {
      message: "provider failed",
      type: "PROVIDER_FAILED" as const,
    },
    failureSource: {
      taskRunDebitRefundable: false,
      type: "PROVIDER" as const,
    },
    jobId: "task-run~task-run-1~attempt~0~orchestrator~failure",
    ownerUserId: "owner-1",
    taskRunId: "task-run-1",
    workflowId: "workflow-1",
  };
}

function wakeUpJob() {
  return {
    jobId: "wake-up~parent-task-run-1",
    ownerUserId: "owner-1",
    parentTaskRunId: "parent-task-run-1",
    workflowId: "workflow-1",
  };
}

class FakeExecutionWorker {
  readonly executed: unknown[] = [];

  execute(job: unknown) {
    this.executed.push(job);

    return Promise.resolve({ claimed: false as const });
  }
}

class FakeOrchestrator {
  readonly completions: unknown[] = [];
  readonly failures: unknown[] = [];
  readonly wakeUps: unknown[] = [];

  constructor(
    private readonly outcomes: {
      readonly completionOutcome?: unknown;
      readonly failureOutcome?: unknown;
      readonly wakeUpError?: Error;
      readonly wakeUpOutcome?: unknown;
    } = {},
  ) {}

  settleWorkerCompletion(job: unknown) {
    this.completions.push(job);

    return Promise.resolve(
      this.outcomes.completionOutcome ?? {
        ok: true as const,
        value: { settled: false as const },
      },
    );
  }

  settleWorkerFailure(job: unknown) {
    this.failures.push(job);

    return Promise.resolve(
      this.outcomes.failureOutcome ?? {
        ok: true as const,
        value: { settled: false as const },
      },
    );
  }

  handleWakeUpCall(job: unknown) {
    this.wakeUps.push(job);
    if (this.outcomes.wakeUpError) {
      return Promise.reject(this.outcomes.wakeUpError);
    }

    return Promise.resolve(
      this.outcomes.wakeUpOutcome ?? {
        ok: true as const,
        value: { executionJobs: [], taskStatusEvents: [] },
      },
    );
  }
}

class FakeQueuedTaskRunRepository {
  readonly commands: { readonly limit: number }[] = [];

  constructor(private readonly jobs: ReturnType<typeof executionJob>[]) {}

  listQueuedTaskRunJobs(command: { readonly limit: number }) {
    this.commands.push(command);

    return Effect.succeed(this.jobs);
  }
}

class FakeExecutionQueue {
  readonly enqueued: ReturnType<typeof executionJob>[] = [];

  enqueueExecutionJobs(jobs: readonly ReturnType<typeof executionJob>[]) {
    this.enqueued.push(...jobs);

    return Promise.resolve();
  }
}
