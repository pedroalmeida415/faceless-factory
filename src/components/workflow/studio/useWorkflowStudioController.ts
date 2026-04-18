"use client";

import { useCallback, useMemo } from "react";

import {
  runSelectedOrAll as runAllWorkflowNodes,
  runNode as runWorkflowNode,
  uploadFilesToNode as uploadWorkflowFilesToNode,
} from "~/components/workflow/studio/runner";
import { ClientRuntime } from "~/effect/client/runtime";
import type { StudioContextValue } from "./context";
import {
  getGeneratorImageInputHandles,
  getGeneratorIterationPreview,
} from "./graph";
import { useWorkflowStudioStore } from "./store";

export function useWorkflowStudioController() {
  const nodes = useWorkflowStudioStore((state) => state.nodes);
  const edges = useWorkflowStudioStore((state) => state.edges);
  const updateNodeData = useWorkflowStudioStore(
    (state) => state.updateNodeData,
  );
  const clearNodeAssets = useWorkflowStudioStore(
    (state) => state.clearNodeAssets,
  );

  const getGeneratorIterationInfo = useCallback(
    (nodeId: string) => getGeneratorIterationPreview(nodes, edges, nodeId),
    [edges, nodes],
  );

  const getGeneratorImageInputs = useCallback(
    (nodeId: string) => getGeneratorImageInputHandles(edges, nodeId),
    [edges],
  );

  const uploadFilesToNode = useCallback(
    async (
      nodeId: string,
      files: File[],
      options: { kind: "image" | "video"; multiple: boolean },
    ) => {
      await ClientRuntime.runPromise(
        uploadWorkflowFilesToNode(nodeId, files, options),
      );
    },
    [],
  );

  const runNode = useCallback(async (nodeId: string) => {
    await ClientRuntime.runPromise(runWorkflowNode(nodeId));
  }, []);

  const runSelectedOrAll = useCallback(async () => {
    await ClientRuntime.runPromise(runAllWorkflowNodes());
  }, []);

  const contextValue = useMemo<StudioContextValue>(
    () => ({
      updateNodeData,
      uploadFilesToNode,
      clearNodeAssets,
      getGeneratorImageInputs,
      getGeneratorIterationInfo,
      runNode,
    }),
    [
      clearNodeAssets,
      getGeneratorImageInputs,
      getGeneratorIterationInfo,
      runNode,
      updateNodeData,
      uploadFilesToNode,
    ],
  );

  return {
    contextValue,
    runSelectedOrAll,
  };
}
