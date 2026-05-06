import { Effect } from "effect";
import { ServerRuntime } from "~/effect/server/runtime";
import { VertexAi } from "~/server/workflow/vertex";
import { WorkflowRuntimeCommands } from "~/server/workflow-runtime/workflow-runtime-commands";
import {
  createWorkflowRuntimeComposition,
  getWorkflowRuntimeManagedRuntime,
} from "~/server/workflow-runtime/workflow-runtime-composition";
import { createWorkflowRuntimeProviderExecutor } from "~/server/workflow-runtime/workflow-runtime-provider-executor";
import { createWorkflowRuntimeWorker } from "~/server/workflow-runtime/workflow-runtime-worker";

async function createProviderExecutor() {
  const vertexAi = await ServerRuntime.runPromise(VertexAi);

  return createWorkflowRuntimeProviderExecutor({
    vertexAi,
  });
}

async function main() {
  const composition = await createWorkflowRuntimeComposition();
  const workflowRuntime = getWorkflowRuntimeManagedRuntime();
  const worker = createWorkflowRuntimeWorker({
    eventPublisher: composition.eventPublisher,
    orchestrator: {
      handleWakeUpCall: (command) =>
        workflowRuntime.runPromise(
          Effect.flatMap(WorkflowRuntimeCommands, (commands) =>
            commands.handleWakeUpCall(command),
          ),
        ),
      settleWorkerCompletion: (command) =>
        workflowRuntime.runPromise(
          Effect.flatMap(WorkflowRuntimeCommands, (commands) =>
            commands.settleWorkerCompletion(command),
          ),
        ),
      settleWorkerFailure: (command) =>
        workflowRuntime.runPromise(
          Effect.flatMap(WorkflowRuntimeCommands, (commands) =>
            commands.settleWorkerFailure(command),
          ),
        ),
    },
    providerExecutor: await createProviderExecutor(),
    queue: composition.queue,
    repository: composition.repository,
  });

  worker.on("completed", (job) => {
    console.info(`Workflow runtime job ${job.id} completed.`);
  });

  worker.on("failed", (job, error) => {
    console.error(`Workflow runtime job ${job?.id ?? "unknown"} failed`, error);
  });

  worker.on("error", (error) => {
    console.error("Workflow runtime worker error", error);
  });

  await worker.waitUntilReady();
  console.info("Workflow runtime worker ready.");

  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.info(`Shutting down workflow runtime worker (${signal}).`);

    await Promise.allSettled([worker.close()]);
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

void main().catch((error) => {
  console.error("Workflow runtime worker failed to start", errorMessage(error));
  console.error(error);
  process.exit(1);
});

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Unknown error";
}
