import { Effect } from "effect";

import { getErrorMessage, WorkflowRequestError } from "~/lib/workflow/errors";
import type { WorkflowExecutionTarget } from "~/lib/workflow/execution/types";
import { WorkflowClientService } from "~/lib/workflow/services/workflow-client";
import { WorkflowPersistenceService } from "~/lib/workflow/services/workflow-persistence-service";
import { WorkflowStudioStoreService } from "~/lib/workflow/services/workflow-studio-store-service";

function isActiveRunStatus(status: "queued" | "running" | "success" | "error") {
  return status === "queued" || status === "running";
}

export const WorkflowExecutionService = {
  run(target: WorkflowExecutionTarget) {
    return Effect.gen(function* () {
      const workflowStudioStore = yield* WorkflowStudioStoreService;
      yield* Effect.tryPromise({
        try: () => WorkflowPersistenceService.flushSave(),
        catch: (cause) =>
          new WorkflowRequestError({
            message: getErrorMessage(cause),
            cause,
          }),
      });

      const snapshot = yield* workflowStudioStore.getWorkflowSnapshot();
      if (!snapshot.projectId || snapshot.documentRevision === null) {
        return yield* Effect.fail(
          new WorkflowRequestError({
            message: "Workflow project is not ready yet.",
          }),
        );
      }

      yield* workflowStudioStore.setExecutionStreaming(true);

      const executionState = yield* WorkflowClientService.startExecution({
        clientRunId: crypto.randomUUID(),
        document: snapshot.document,
        documentRevision: snapshot.documentRevision,
        projectId: snapshot.projectId,
        selection: {
          nodeIds: snapshot.editor.selectedNodeIds,
        },
        target,
      });

      yield* workflowStudioStore.setActiveRunId(executionState.runId);
      yield* workflowStudioStore.applyServerExecutionState(executionState);

      if (!isActiveRunStatus(executionState.status)) {
        yield* workflowStudioStore.clearActiveRunId();
        return;
      }

      yield* Effect.async<void, WorkflowRequestError>((resume) => {
        let settled = false;

        const subscription = WorkflowClientService.openExecutionEvents(
          executionState.runId,
          {
            onExecutionState: (nextExecutionState) => {
              void Effect.runPromise(
                workflowStudioStore.applyServerExecutionState(
                  nextExecutionState,
                ),
              )
                .then(() => {
                  if (isActiveRunStatus(nextExecutionState.status) || settled) {
                    return;
                  }

                  settled = true;
                  subscription.unsubscribe();

                  void Effect.runPromise(
                    workflowStudioStore.clearActiveRunId(),
                  ).finally(() => {
                    resume(Effect.void);
                  });
                })
                .catch((cause) => {
                  if (settled) {
                    return;
                  }

                  settled = true;
                  subscription.unsubscribe();
                  resume(
                    Effect.fail(
                      new WorkflowRequestError({
                        message: getErrorMessage(cause),
                        cause,
                      }),
                    ),
                  );
                });
            },
            onError: (error) => {
              if (settled) {
                return;
              }

              settled = true;
              subscription.unsubscribe();
              resume(Effect.fail(error));
            },
          },
        );

        return Effect.sync(() => {
          subscription.unsubscribe();
        });
      });
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const workflowStudioStore = yield* WorkflowStudioStoreService;
          yield* workflowStudioStore.clearActiveRunId();
          yield* workflowStudioStore.setExecutionStreaming(false);
          yield* workflowStudioStore.setActivity(getErrorMessage(error));
        }),
      ),
    );
  },
};
