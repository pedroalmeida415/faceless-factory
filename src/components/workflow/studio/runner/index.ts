"use client";

import { Effect } from "effect";
import { buildIncomingByTarget } from "~/components/workflow/studio/graph";
import { getErrorMessage } from "~/lib/workflow/errors";
import type { WorkflowNodeData } from "~/lib/workflow/types";
import { isGeneratorNodeKind } from "~/lib/workflow/types";
import { evaluateNode } from "./evaluation";
import type { NodeMap, PendingMap } from "./shared";
import { setActivity } from "./state-effects";
import { WorkflowStudioStoreService } from "./store-service";

export { uploadFilesToNode } from "./uploads";

export const runNode = (nodeId: string) =>
  Effect.gen(function* () {
    const workflowStudioStore = yield* WorkflowStudioStoreService;
    const snapshot = yield* workflowStudioStore.getGraphSnapshot();
    const nodeMap: NodeMap = new Map(
      snapshot.nodes.map((node) => [node.id, node]),
    );
    const incomingByTarget = buildIncomingByTarget(snapshot.edges);
    const pending: PendingMap = new Map();

    yield* evaluateNode(nodeId, new Set(), nodeMap, incomingByTarget, pending);
    yield* workflowStudioStore.setActivity("Workflow run finished.");
  }).pipe(
    Effect.catchAll((error) =>
      setActivity(getErrorMessage(error)).pipe(Effect.asVoid),
    ),
  );

export const runSelectedOrAll = () =>
  Effect.gen(function* () {
    const workflowStudioStore = yield* WorkflowStudioStoreService;
    const { nodes } = yield* workflowStudioStore.getGraphSnapshot();
    const selectedGeneratorIds = nodes
      .filter(
        (node) =>
          node.selected &&
          isGeneratorNodeKind((node.data as WorkflowNodeData).kind),
      )
      .map((node) => node.id);

    const targetIds =
      selectedGeneratorIds.length > 0
        ? selectedGeneratorIds
        : nodes
            .filter((node) =>
              isGeneratorNodeKind((node.data as WorkflowNodeData).kind),
            )
            .map((node) => node.id);

    if (!targetIds.length) {
      yield* workflowStudioStore.setActivity(
        "Add an image or video generator first.",
      );
      return;
    }

    yield* Effect.forEach(targetIds, runNode, {
      concurrency: 1,
      discard: true,
    });
  });
