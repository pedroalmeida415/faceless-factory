import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect, Fiber, Layer, Schedule, TestClock, TestContext } from "effect";

import type { TaskStatusEvent } from "~/lib/workflow-runtime/runtime/task-status-events";
import {
  WorkflowRuntimeEventPublisher,
  WorkflowRuntimeQueue,
} from "~/server/workflow-runtime/workflow-runtime-commands";
import {
  type PostCommitWork,
  WorkflowRuntimePostCommitWork,
} from "~/server/workflow-runtime/workflow-runtime-post-commit-work";
import type {
  WorkflowRuntimeExecutionJobPayload,
  WorkflowRuntimeWakeUpJobPayload,
} from "~/server/workflow-runtime/workflow-runtime-queue";
import {
  type WorkflowRuntimePostCommitDeliveryTelemetry,
  WorkflowRuntimeTelemetry,
} from "~/server/workflow-runtime/workflow-runtime-telemetry";

describe("WorkflowRuntimePostCommitWork", () => {
  test("delivers empty work without transport calls", async () => {
    const calls: string[] = [];

    await runDeliver(emptyWork(), { calls });

    assert.deepEqual(calls, []);
  });

  test("delivers execution jobs, Wake-Up Call jobs, then Task Status Events in order", async () => {
    const calls: string[] = [];

    await runDeliver(
      work({
        executionJobs: [executionJob("exec-1"), executionJob("exec-2")],
        taskStatusEvents: [
          taskStatusEvent("event-1"),
          taskStatusEvent("event-2", "PENDING_REVIEW"),
        ],
        wakeUpJobs: [wakeUpJob("wake-1"), wakeUpJob("wake-2")],
      }),
      { calls },
    );

    assert.deepEqual(calls, [
      "execution:exec-1",
      "execution:exec-2",
      "wake-up:wake-1",
      "wake-up:wake-2",
      "event:event-1:APPROVED",
      "event:event-2:PENDING_REVIEW",
    ]);
  });

  test("uses item-level queue and event methods for retry targets", async () => {
    const calls: string[] = [];

    await runDeliver(
      work({
        executionJobs: [executionJob("exec-1")],
        taskStatusEvents: [taskStatusEvent("event-1")],
        wakeUpJobs: [wakeUpJob("wake-1")],
      }),
      { batchMethodsFail: true, calls },
    );

    assert.deepEqual(calls, [
      "execution:exec-1",
      "wake-up:wake-1",
      "event:event-1:APPROVED",
    ]);
  });

  test("retries an individual item without redelivering prior successes", async () => {
    const calls: string[] = [];
    const failures = new Map([["execution:exec-2", 1]]);

    await runDeliver(
      work({
        executionJobs: [executionJob("exec-1"), executionJob("exec-2")],
      }),
      { calls, failures, retrySchedule: Schedule.recurs(2) },
    );

    assert.deepEqual(calls, [
      "execution:exec-1",
      "execution:exec-2",
      "execution:exec-2",
    ]);
  });

  test("continues ordered delivery after an exhausted item", async () => {
    const calls: string[] = [];
    const exhausted: WorkflowRuntimePostCommitDeliveryTelemetry[] = [];
    const failures = new Map([["execution:exec-1", Number.POSITIVE_INFINITY]]);

    await runDeliver(
      work({
        executionJobs: [executionJob("exec-1"), executionJob("exec-2")],
        taskStatusEvents: [taskStatusEvent("event-1")],
        wakeUpJobs: [wakeUpJob("wake-1")],
      }),
      { calls, exhausted, failures, retrySchedule: Schedule.recurs(1) },
    );

    assert.deepEqual(calls, [
      "execution:exec-1",
      "execution:exec-1",
      "execution:exec-2",
      "wake-up:wake-1",
      "event:event-1:APPROVED",
    ]);
    assert.equal(exhausted.length, 1);
    assert.equal(exhausted[0]?.kind, "execution-job");
  });

  test("records structured observability for exhausted delivery", async () => {
    const attempts: WorkflowRuntimePostCommitDeliveryTelemetry[] = [];
    const exhausted: WorkflowRuntimePostCommitDeliveryTelemetry[] = [];
    const failures = new Map([
      ["event:event-1:APPROVED", Number.POSITIVE_INFINITY],
    ]);

    await runDeliver(work({ taskStatusEvents: [taskStatusEvent("event-1")] }), {
      attempts,
      exhausted,
      failures,
      retrySchedule: Schedule.recurs(2),
    });

    assert.equal(attempts.length, 3);
    assert.deepEqual(exhausted, [
      {
        attempt: 3,
        cause: "forced event:event-1:APPROVED failure",
        itemIndex: 0,
        kind: "task-status-event",
        nodeExecutionId: "node-execution-event-1",
        source: "start-workflow-run",
        status: "APPROVED",
        taskRunId: "event-1",
        workflowId: "workflow-1",
      },
    ]);
  });

  test("remains interruptible while waiting on retry backoff", async () => {
    const calls: string[] = [];
    const failures = new Map([["execution:exec-1", Number.POSITIVE_INFINITY]]);

    await Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        WorkflowRuntimePostCommitWork.deliver(
          work({ executionJobs: [executionJob("exec-1")] }),
        ),
      );
      yield* Effect.yieldNow();
      assert.deepEqual(calls, ["execution:exec-1"]);

      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust("1 hour");
      assert.deepEqual(calls, ["execution:exec-1"]);
    }).pipe(
      Effect.provide(
        makeLayer({
          calls,
          failures,
          retrySchedule: Schedule.spaced("1 hour").pipe(
            Schedule.intersect(Schedule.recurs(2)),
          ),
        }),
      ),
      Effect.provide(TestContext.TestContext),
      Effect.runPromise,
    );
  });
});

function runDeliver(work: PostCommitWork, options: LayerOptions) {
  return WorkflowRuntimePostCommitWork.deliver(work).pipe(
    Effect.provide(makeLayer(options)),
    Effect.runPromise,
  );
}

type LayerOptions = {
  readonly attempts?: WorkflowRuntimePostCommitDeliveryTelemetry[];
  readonly batchMethodsFail?: boolean;
  readonly calls?: string[];
  readonly exhausted?: WorkflowRuntimePostCommitDeliveryTelemetry[];
  readonly failures?: Map<string, number>;
  readonly retrySchedule?: Parameters<
    typeof WorkflowRuntimePostCommitWork.layerWithSchedule
  >[0];
};

function makeLayer({
  attempts = [],
  batchMethodsFail = false,
  calls = [],
  exhausted = [],
  failures = new Map(),
  retrySchedule = Schedule.recurs(0),
}: LayerOptions) {
  return WorkflowRuntimePostCommitWork.layerWithSchedule(retrySchedule).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(WorkflowRuntimeQueue, {
          enqueueExecutionJob: (job) =>
            Effect.tryPromise({
              try: () => record(`execution:${job.jobId}`, calls, failures),
              catch: (cause) => cause,
            }),
          enqueueExecutionJobs: ([job]) =>
            batchMethodsFail
              ? Promise.reject(new Error("batch execution enqueue called"))
              : record(
                  `${job ? `execution:${job.jobId}` : "execution:missing"}`,
                  calls,
                  failures,
                ),
          enqueueWakeUpJob: (job) =>
            Effect.tryPromise({
              try: () => record(`wake-up:${job.jobId}`, calls, failures),
              catch: (cause) => cause,
            }),
          enqueueWakeUpJobs: ([job]) =>
            batchMethodsFail
              ? Promise.reject(new Error("batch wake-up enqueue called"))
              : record(
                  `${job ? `wake-up:${job.jobId}` : "wake-up:missing"}`,
                  calls,
                  failures,
                ),
        }),
        Layer.succeed(WorkflowRuntimeEventPublisher, {
          publishTaskStatusEvent: (_workflowId, event) =>
            Effect.tryPromise({
              try: () =>
                record(
                  `event:${event.taskRunId}:${event.status}`,
                  calls,
                  failures,
                ),
              catch: (cause) => cause,
            }),
          publishTaskStatusEvents: (_workflowId, [event]) =>
            batchMethodsFail
              ? Promise.reject(new Error("batch event publish called"))
              : record(
                  event
                    ? `event:${event.taskRunId}:${event.status}`
                    : "event:missing",
                  calls,
                  failures,
                ),
        }),
        Layer.succeed(WorkflowRuntimeTelemetry, {
          config: WorkflowRuntimeTelemetry.fromEnv({}),
          postCommitDeliveryAttemptFailed: (details) =>
            Effect.sync(() => {
              attempts.push(details);
            }),
          postCommitDeliveryExhausted: (details) =>
            Effect.sync(() => {
              exhausted.push(details);
            }),
        }),
      ),
    ),
  );
}

function record(key: string, calls: string[], failures: Map<string, number>) {
  calls.push(key);
  const remaining = failures.get(key) ?? 0;
  if (remaining > 0) {
    failures.set(key, remaining - 1);
    return Promise.reject(new Error(`forced ${key} failure`));
  }
  return Promise.resolve();
}

function emptyWork(): PostCommitWork {
  return work({});
}

function work(input: Partial<PostCommitWork>): PostCommitWork {
  return {
    executionJobs: [],
    source: "start-workflow-run",
    taskStatusEvents: [],
    wakeUpJobs: [],
    workflowId: "workflow-1",
    ...input,
  };
}

function executionJob(jobId: string): WorkflowRuntimeExecutionJobPayload {
  return {
    attempt: 0,
    itemIndex: 0,
    jobId,
    nodeExecutionId: `node-execution-${jobId}`,
    ownerUserId: "owner-1",
    taskRunId: jobId,
    workflowId: "workflow-1",
  };
}

function wakeUpJob(jobId: string): WorkflowRuntimeWakeUpJobPayload {
  return {
    jobId,
    ownerUserId: "owner-1",
    parentTaskRunId: jobId,
    workflowId: "workflow-1",
  };
}

function taskStatusEvent(
  taskRunId: string,
  status: TaskStatusEvent["status"] = "APPROVED",
): TaskStatusEvent {
  return {
    attempt: 0,
    itemIndex: 0,
    nodeExecutionId: `node-execution-${taskRunId}`,
    status,
    taskRunId,
  };
}
