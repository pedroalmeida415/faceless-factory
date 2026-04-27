import { Effect } from "effect";

import { ServerRuntime } from "~/effect/server/runtime";
import { getErrorMessage } from "~/lib/workflow/errors";
import { WorkflowExecutionService } from "~/server/workflow/execution-service";
import {
  createWorkflowExecutionQueueEvents,
  createWorkflowExecutionWorker,
  getWorkflowExecutionJob,
} from "~/server/workflow/queue";

async function failWorkflowRun(params: {
  message: string;
  runId: string;
  userId: string;
}) {
  await ServerRuntime.runPromise(
    Effect.gen(function* () {
      const workflowExecutionService = yield* WorkflowExecutionService;
      yield* workflowExecutionService.failRun(params);
    }),
  );
}

async function main() {
  const worker = createWorkflowExecutionWorker(async (job) => {
    await ServerRuntime.runPromise(
      Effect.gen(function* () {
        const workflowExecutionService = yield* WorkflowExecutionService;
        if (job.data.type === "regenerate-review-lane") {
          yield* workflowExecutionService.executeReviewLaneRegeneration({
            laneIndex: job.data.laneIndex,
            reviewNodeId: job.data.reviewNodeId,
            runId: job.data.runId,
            userId: job.data.userId,
          });
          return;
        }

        yield* workflowExecutionService.executeRun(
          job.data.runId,
          job.data.userId,
          job.data.request,
        );
      }),
    );
  });

  const queueEvents = createWorkflowExecutionQueueEvents();

  queueEvents.on("error", (error) => {
    console.error("Workflow queue events error", error);
  });

  queueEvents.on("failed", async ({ failedReason, jobId }) => {
    if (!jobId) {
      return;
    }

    try {
      const job = await getWorkflowExecutionJob(jobId);
      if (!job) {
        return;
      }

      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < maxAttempts) {
        return;
      }

      if (
        job.data.type === "execute-run" &&
        job.data.request.executionLaneFilter
      ) {
        return;
      }

      await failWorkflowRun({
        message: failedReason || "Workflow execution job failed.",
        runId: job.data.runId,
        userId: job.data.userId,
      });
    } catch (error) {
      console.error("Failed to transition failed workflow job", error);
    }
  });

  worker.on("completed", (job) => {
    console.info(`Workflow job ${job.id} completed.`);
  });

  worker.on("error", (error) => {
    console.error("Workflow worker error", error);
  });

  worker.on("failed", (job, error) => {
    console.error(`Workflow job ${job?.id ?? "unknown"} failed`, error);
  });

  await Promise.all([worker.waitUntilReady(), queueEvents.waitUntilReady()]);
  console.info("Workflow worker ready.");

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.info(`Shutting down workflow worker (${signal}).`);

    await Promise.allSettled([
      worker.close(),
      queueEvents.close(),
      ServerRuntime.dispose(),
    ]);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").finally(() => {
      process.exit(0);
    });
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").finally(() => {
      process.exit(0);
    });
  });
}

void main().catch(async (error) => {
  console.error("Workflow worker failed to start", getErrorMessage(error));
  console.error(error);
  await ServerRuntime.dispose().catch(() => {
    return undefined;
  });
  process.exit(1);
});
