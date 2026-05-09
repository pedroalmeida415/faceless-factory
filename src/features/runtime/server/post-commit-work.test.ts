import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import {
  Effect,
  Fiber,
  Layer,
  Logger,
  LogLevel,
  Metric,
  Schedule,
  TestClock,
  TestContext,
} from "effect";

import type { TaskStatusEvent } from "~/features/runtime/events/task-status-events";
import { EventPublisherService } from "~/features/runtime/server/commands";
import {
  type PostCommitWork,
  RuntimePostCommitWork,
} from "~/features/runtime/server/post-commit-work";
import type {
  RuntimeExecutionJobPayload,
  RuntimeWakeUpJobPayload,
} from "~/server/services/queue";
import { QueueService } from "~/server/services/queue";
import {
  type RuntimePostCommitDeliveryTelemetry,
  runtimeTelemetryMetrics,
  TelemetryService,
} from "~/server/services/telemetry";

describe("RuntimePostCommitWork", () => {
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
      { calls },
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
    const exhausted: RuntimePostCommitDeliveryTelemetry[] = [];
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
    const attempts: RuntimePostCommitDeliveryTelemetry[] = [];
    const exhausted: RuntimePostCommitDeliveryTelemetry[] = [];
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
        branchIndex: 0,
        kind: "task-status-event",
        nodeRunId: "node-execution-event-1",
        source: "start-workflow-run",
        status: "APPROVED",
        taskId: "event-1",
        workflowId: "workflow-1",
      },
    ]);
  });

  test("records real telemetry for failed and exhausted Post-Commit Work delivery", async () => {
    const logs: Array<{ level: string; message: unknown }> = [];
    const failures = new Map([
      ["event:event-real-telemetry:PENDING_REVIEW", Number.POSITIVE_INFINITY],
    ]);
    const event = taskStatusEvent("event-real-telemetry", "PENDING_REVIEW");
    const taggedAttemptFailures = tagPostCommitMetric(
      runtimeTelemetryMetrics.postCommitAttemptFailures,
      {
        kind: "task-status-event",
        source: "settle-worker-completion",
        status: event.status,
        taskId: event.taskId,
        workflowId: "workflow-real-telemetry",
      },
    );
    const taggedExhaustedFailures = tagPostCommitMetric(
      runtimeTelemetryMetrics.postCommitExhaustedFailures,
      {
        kind: "task-status-event",
        source: "settle-worker-completion",
        status: event.status,
        taskId: event.taskId,
        workflowId: "workflow-real-telemetry",
      },
    );

    await RuntimePostCommitWork.deliver(
      work({
        source: "settle-worker-completion",
        taskStatusEvents: [event],
        workflowId: "workflow-real-telemetry",
      }),
    ).pipe(
      Effect.provide(
        makeLayer({
          failures,
          retrySchedule: Schedule.recurs(1),
          telemetryLayer: TelemetryService.Test,
        }),
      ),
      Effect.provide(
        Logger.replace(
          Logger.defaultLogger,
          Logger.make((entry) => {
            logs.push({
              level: entry.logLevel.label,
              message: entry.message,
            });
          }),
        ),
      ),
      Logger.withMinimumLogLevel(LogLevel.Debug),
      Effect.runPromise,
    );

    assert.equal(await metricCount(taggedAttemptFailures), 2);
    assert.equal(await metricCount(taggedExhaustedFailures), 1);
    assert.deepEqual(logs, [
      {
        level: "DEBUG",
        message: [
          "Runtime Post-Commit Work delivery attempt failed",
          {
            attempt: 1,
            cause: "forced event:event-real-telemetry:PENDING_REVIEW failure",
            branchIndex: 0,
            kind: "task-status-event",
            nodeRunId: "node-execution-event-real-telemetry",
            source: "settle-worker-completion",
            status: "PENDING_REVIEW",
            taskId: "event-real-telemetry",
            workflowId: "workflow-real-telemetry",
          },
        ],
      },
      {
        level: "DEBUG",
        message: [
          "Runtime Post-Commit Work delivery attempt failed",
          {
            attempt: 2,
            cause: "forced event:event-real-telemetry:PENDING_REVIEW failure",
            branchIndex: 0,
            kind: "task-status-event",
            nodeRunId: "node-execution-event-real-telemetry",
            source: "settle-worker-completion",
            status: "PENDING_REVIEW",
            taskId: "event-real-telemetry",
            workflowId: "workflow-real-telemetry",
          },
        ],
      },
      {
        level: "WARN",
        message: [
          "Runtime Post-Commit Work delivery exhausted",
          {
            attempt: 2,
            cause: "forced event:event-real-telemetry:PENDING_REVIEW failure",
            branchIndex: 0,
            kind: "task-status-event",
            nodeRunId: "node-execution-event-real-telemetry",
            source: "settle-worker-completion",
            status: "PENDING_REVIEW",
            taskId: "event-real-telemetry",
            workflowId: "workflow-real-telemetry",
          },
        ],
      },
    ]);
  });

  test("remains interruptible while waiting on retry backoff", async () => {
    const calls: string[] = [];
    const failures = new Map([["execution:exec-1", Number.POSITIVE_INFINITY]]);

    await Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        RuntimePostCommitWork.deliver(
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
  return RuntimePostCommitWork.deliver(work).pipe(
    Effect.provide(makeLayer(options)),
    Effect.runPromise,
  );
}

type LayerOptions = {
  readonly attempts?: RuntimePostCommitDeliveryTelemetry[];
  readonly calls?: string[];
  readonly exhausted?: RuntimePostCommitDeliveryTelemetry[];
  readonly failures?: Map<string, number>;
  readonly retrySchedule?: Parameters<
    typeof RuntimePostCommitWork.layerWithSchedule
  >[0];
  readonly telemetryLayer?: Layer.Layer<TelemetryService>;
};

function makeLayer({
  attempts = [],
  calls = [],
  exhausted = [],
  failures = new Map(),
  retrySchedule = Schedule.recurs(0),
  telemetryLayer,
}: LayerOptions) {
  return RuntimePostCommitWork.layerWithSchedule(retrySchedule).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(QueueService, {
          enqueueExecutionJob: (job) =>
            Effect.tryPromise({
              try: () => record(`execution:${job.jobId}`, calls, failures),
              catch: (cause) => cause,
            }),
          enqueueWakeUpJob: (job) =>
            Effect.tryPromise({
              try: () => record(`wake-up:${job.jobId}`, calls, failures),
              catch: (cause) => cause,
            }),
        }),
        Layer.succeed(EventPublisherService, {
          publishTaskStatusEvent: (_workflowId, event) =>
            Effect.tryPromise({
              try: () =>
                record(
                  `event:${event.taskId}:${event.status}`,
                  calls,
                  failures,
                ),
              catch: (cause) => cause,
            }),
        }),
        telemetryLayer ??
          Layer.succeed(TelemetryService, {
            config: {
              enabled: false,
              exporterEndpoint: null,
              serviceName: "faceless-factory-runtime",
            },
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

function tagPostCommitMetric(
  metric: (typeof runtimeTelemetryMetrics)[keyof typeof runtimeTelemetryMetrics],
  tags: {
    readonly kind: RuntimePostCommitDeliveryTelemetry["kind"];
    readonly source: string;
    readonly status?: string;
    readonly taskId?: string;
    readonly workflowId: string;
  },
) {
  return metric.pipe(
    Metric.tagged("work_kind", tags.kind),
    Metric.tagged("source", tags.source),
    Metric.tagged("workflow_id", tags.workflowId),
    Metric.tagged("task_id", tags.taskId ?? "none"),
    Metric.tagged("status", tags.status ?? "none"),
  );
}

async function metricCount(
  metric: (typeof runtimeTelemetryMetrics)[keyof typeof runtimeTelemetryMetrics],
) {
  const state = await Effect.runPromise(Metric.value(metric));

  return state.count;
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

function executionJob(jobId: string): RuntimeExecutionJobPayload {
  return {
    branchIndex: 0,
    jobId,
    nodeRunId: `node-execution-${jobId}`,
    ownerUserId: "owner-1",
    taskId: jobId,
    workflowId: "workflow-1",
  };
}

function wakeUpJob(jobId: string): RuntimeWakeUpJobPayload {
  return {
    jobId,
    ownerUserId: "owner-1",
    parentTaskId: jobId,
    workflowId: "workflow-1",
  };
}

function taskStatusEvent(
  taskId: string,
  status: TaskStatusEvent["status"] = "APPROVED",
): TaskStatusEvent {
  return {
    branchIndex: 0,
    nodeRunId: `node-execution-${taskId}`,
    status,
    taskId,
  };
}
