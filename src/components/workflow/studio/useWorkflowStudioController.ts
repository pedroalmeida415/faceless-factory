"use client";

import { useCallback, useMemo } from "react";

import {
  runNode as runWorkflowNode,
  uploadFilesToNode as uploadWorkflowFilesToNode,
} from "~/components/workflow/studio/runner";
import { ClientRuntime } from "~/effect/client/runtime";
import { estimateWorkflowExecution } from "~/lib/workflow/pricing";
import type { StudioContextValue } from "./context";
import {
  getGeneratorInputHandles,
  getGeneratorIterationPreview,
} from "./graph";
import { useWorkflowStudioStore } from "./store";

export function useWorkflowStudioController() {
  const setPrompt = useWorkflowStudioStore((state) => state.setPrompt);
  const clearNodeAssets = useWorkflowStudioStore(
    (state) => state.clearNodeAssets,
  );
  const setImageGeneratorModel = useWorkflowStudioStore(
    (state) => state.setImageGeneratorModel,
  );
  const setVideoGeneratorModel = useWorkflowStudioStore(
    (state) => state.setVideoGeneratorModel,
  );
  const setImageGeneratorMode = useWorkflowStudioStore(
    (state) => state.setImageGeneratorMode,
  );
  const setVideoGeneratorMode = useWorkflowStudioStore(
    (state) => state.setVideoGeneratorMode,
  );
  const setImageGeneratorConfigValue = useWorkflowStudioStore(
    (state) => state.setImageGeneratorConfigValue,
  );
  const setVideoGeneratorConfigValue = useWorkflowStudioStore(
    (state) => state.setVideoGeneratorConfigValue,
  );

  const getGeneratorIterationInfo = useCallback((nodeId: string) => {
    const { document } = useWorkflowStudioStore.getState();
    return getGeneratorIterationPreview(document, nodeId);
  }, []);

  const getGeneratorInputs = useCallback((nodeId: string) => {
    const { document } = useWorkflowStudioStore.getState();
    return getGeneratorInputHandles(document, nodeId);
  }, []);

  const getGeneratorRunCost = useCallback((nodeId: string) => {
    const { document } = useWorkflowStudioStore.getState();

    try {
      return estimateWorkflowExecution({
        document,
        target: { type: "node", nodeId },
      });
    } catch {
      return null;
    }
  }, []);

  const uploadFilesToNode = useCallback(
    async (nodeId: string, files: File[]) => {
      await ClientRuntime.runPromise(uploadWorkflowFilesToNode(nodeId, files));
    },
    [],
  );

  const runNode = useCallback(async (nodeId: string) => {
    await ClientRuntime.runPromise(runWorkflowNode(nodeId));
  }, []);

  const contextValue = useMemo<StudioContextValue>(
    () => ({
      setPrompt,
      uploadFilesToNode,
      clearNodeAssets,
      getGeneratorInputs,
      getGeneratorIterationInfo,
      getGeneratorRunCost,
      setImageGeneratorModel,
      setVideoGeneratorModel,
      setImageGeneratorMode,
      setVideoGeneratorMode,
      setImageGeneratorConfigValue,
      setVideoGeneratorConfigValue,
      runNode,
    }),
    [
      clearNodeAssets,
      getGeneratorInputs,
      getGeneratorIterationInfo,
      getGeneratorRunCost,
      runNode,
      setImageGeneratorConfigValue,
      setImageGeneratorMode,
      setImageGeneratorModel,
      setPrompt,
      setVideoGeneratorConfigValue,
      setVideoGeneratorMode,
      setVideoGeneratorModel,
      uploadFilesToNode,
    ],
  );

  return {
    contextValue,
  };
}
