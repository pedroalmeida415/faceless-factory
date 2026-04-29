import { Effect } from "effect";

import { getErrorMessage, WorkflowRequestError } from "~/lib/workflow/errors";
import {
  isWorkflowExecutionActiveStatus,
  type WorkflowExecutionTarget,
} from "~/lib/workflow/execution/types";
import { WorkflowClientService } from "~/lib/workflow/services/workflow-client";
import { WorkflowPersistenceService } from "~/lib/workflow/services/workflow-persistence-service";
import { WorkflowStudioStoreService } from "~/lib/workflow/services/workflow-studio-store-service";

export const WorkflowExecutionService = {
  start(target: WorkflowExecutionTarget) {
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
        clientExecutionId: crypto.randomUUID(),
        document: snapshot.document,
        documentRevision: snapshot.documentRevision,
        projectId: snapshot.projectId,
        selection: {
          nodeIds: snapshot.editor.selectedNodeIds,
        },
        target,
      });

      yield* workflowStudioStore.setActiveExecutionId(
        executionState.executionId,
      );
      yield* workflowStudioStore.applyServerExecutionState(executionState);

      if (!isWorkflowExecutionActiveStatus(executionState.status)) {
        yield* workflowStudioStore.clearActiveExecutionId();
        return;
      }

      yield* Effect.async<void, WorkflowRequestError>((resume) => {
        let settled = false;

        const subscription = WorkflowClientService.openExecutionEvents(
          executionState.executionId,
          {
            onExecutionState: (nextExecutionState) => {
              void Effect.runPromise(
                workflowStudioStore.applyServerExecutionState(
                  nextExecutionState,
                ),
              )
                .then(() => {
                  if (
                    isWorkflowExecutionActiveStatus(
                      nextExecutionState.status,
                    ) ||
                    settled
                  ) {
                    return;
                  }

                  settled = true;
                  subscription.unsubscribe();

                  void Effect.runPromise(
                    workflowStudioStore.clearActiveExecutionId(),
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
          yield* workflowStudioStore.clearActiveExecutionId();
          yield* workflowStudioStore.setExecutionStreaming(false);
          yield* workflowStudioStore.setActivity(getErrorMessage(error));
        }),
      ),
    );
  },
};
