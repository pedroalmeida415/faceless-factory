import { Effect } from "effect";

import { getErrorMessage, WorkflowRequestError } from "~/lib/workflow/errors";
import { WorkflowClientService } from "~/lib/workflow/services/workflow-client";
import { WorkflowPersistenceService } from "~/lib/workflow/services/workflow-persistence-service";
import { WorkflowStudioStoreService } from "~/lib/workflow/services/workflow-studio-store-service";
import { hasActiveTaskRunProjection } from "~/lib/workflow-runtime/task-run-studio-projection";

export const WorkflowExecutionService = {
  preview(target: { type: "node"; nodeId: string }) {
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

      return yield* WorkflowClientService.previewRunNode({
        nodeId: target.nodeId,
        projectId: snapshot.projectId,
      });
    });
  },

  start(target: { type: "node"; nodeId: string }) {
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
      const projectId = snapshot.projectId;

      yield* workflowStudioStore.setExecutionStreaming(true);

      yield* WorkflowClientService.runNode({
        nodeId: target.nodeId,
        projectId,
      });

      const initialProjection =
        yield* WorkflowClientService.getTaskProjection(projectId);
      yield* workflowStudioStore.applyRuntimeTaskProjection(initialProjection);

      if (!hasActiveTaskRunProjection(initialProjection)) {
        yield* workflowStudioStore.clearExecutionStreaming();
        return;
      }

      yield* Effect.async<void, WorkflowRequestError>((resume) => {
        let settled = false;
        let refreshing = false;
        let refreshAgain = false;

        const refreshProjection = () => {
          if (refreshing) {
            refreshAgain = true;
            return;
          }

          refreshing = true;
          void Effect.runPromise(
            WorkflowClientService.getTaskProjection(projectId).pipe(
              Effect.flatMap((projection) =>
                workflowStudioStore
                  .applyRuntimeTaskProjection(projection)
                  .pipe(Effect.as(projection)),
              ),
            ),
          )
            .then((projection) => {
              if (!hasActiveTaskRunProjection(projection) && !settled) {
                settled = true;
                subscription.unsubscribe();
                void Effect.runPromise(
                  workflowStudioStore.clearExecutionStreaming(),
                ).finally(() => resume(Effect.void));
              }
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
            })
            .finally(() => {
              refreshing = false;
              if (refreshAgain && !settled) {
                refreshAgain = false;
                refreshProjection();
              }
            });
        };

        const subscription = WorkflowClientService.openTaskEvents(projectId, {
          onTaskEvent: refreshProjection,
          onError: (error) => {
            if (settled) {
              return;
            }

            settled = true;
            subscription.unsubscribe();
            resume(Effect.fail(error));
          },
        });

        return Effect.sync(() => {
          subscription.unsubscribe();
        });
      });
    }).pipe(
      Effect.catchAll((error) =>
        Effect.gen(function* () {
          const workflowStudioStore = yield* WorkflowStudioStoreService;
          yield* workflowStudioStore.clearExecutionStreaming();
          yield* workflowStudioStore.setExecutionStreaming(false);
          yield* workflowStudioStore.setActivity(getErrorMessage(error));
        }),
      ),
    );
  },
};
