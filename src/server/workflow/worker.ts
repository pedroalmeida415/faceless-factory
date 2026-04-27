import { Effect } from "effect";

import { ServerRuntime } from "~/effect/server/runtime";
import { getErrorMessage } from "~/lib/workflow/errors";
import { WorkflowExecutionService } from "~/server/workflow/execution-service";
import { createWorkflowExecutionWorker } from "~/server/workflow/queue";

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

async function settleFailedExecutionLane(params: {
  laneIndex: number;
  message: string;
  nodeId: string;
  runId: string;
  userId: string;
}) {
  await ServerRuntime.runPromise(
    Effect.gen(function* () {
      const workflowExecutionService = yield* WorkflowExecutionService;
      yield* workflowExecutionService.settleFailedExecutionLane(params);
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
            attempt: job.data.attempt,
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

  worker.on("failed", async (job, error) => {
    console.error(`Workflow job ${job?.id ?? "unknown"} failed`, error);
    if (!job) {
      return;
    }
    try {
      const maxAttempts = job.opts.attempts ?? 1;
      if (job.attemptsMade < maxAttempts) {
        return;
      }

      if (
        job.data.type === "execute-run" &&
        job.data.request.executionLaneFilter
      ) {
        const nodeId = job.data.request.selection?.nodeIds?.[0];
        if (nodeId) {
          await settleFailedExecutionLane({
            laneIndex: job.data.request.executionLaneFilter.laneIndex,
            message:
              getErrorMessage(error) || "Workflow execution lane failed.",
            nodeId,
            runId: job.data.runId,
            userId: job.data.userId,
          });
        }
        return;
      }

      await failWorkflowRun({
        message: getErrorMessage(error) || "Workflow execution job failed.",
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

  await worker.waitUntilReady();
  console.info("Workflow worker ready.");

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.info(`Shutting down workflow worker (${signal}).`);

    await Promise.allSettled([worker.close(), ServerRuntime.dispose()]);
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
