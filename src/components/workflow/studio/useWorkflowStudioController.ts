"use client";

import { useCallback, useMemo } from "react";

import { ClientRuntime } from "~/effect/client/runtime";
import { WorkflowAssetService } from "~/lib/workflow/services/workflow-asset-service";
import { WorkflowExecutionService } from "~/lib/workflow/services/workflow-execution-service";
import { api } from "~/trpc/react";
import type { StudioContextValue } from "./context";
import {
  getGeneratorInputHandles,
  getGeneratorIterationPreview,
} from "./graph";
import { useWorkflowStudioStore } from "./store";

export function useWorkflowStudioController() {
  const utils = api.useUtils();
  const projectId = useWorkflowStudioStore((state) => state.projectId);
  const setListItems = useWorkflowStudioStore((state) => state.setListItems);
  const setPrompt = useWorkflowStudioStore((state) => state.setPrompt);
  const setPromptDisplayMode = useWorkflowStudioStore(
    (state) => state.setPromptDisplayMode,
  );
  const addPromptVariable = useWorkflowStudioStore(
    (state) => state.addPromptVariable,
  );
  const clearNodeAssets = useWorkflowStudioStore(
    (state) => state.clearNodeAssets,
  );
  const setImageGeneratorModel = useWorkflowStudioStore(
    (state) => state.setImageGeneratorModel,
  );
  const setLaneReorderMode = useWorkflowStudioStore(
    (state) => state.setLaneReorderMode,
  );
  const setLaneReorderOrder = useWorkflowStudioStore(
    (state) => state.setLaneReorderOrder,
  );
  const setLaneReorderShift = useWorkflowStudioStore(
    (state) => state.setLaneReorderShift,
  );
  const setLaneSelectIndices = useWorkflowStudioStore(
    (state) => state.setLaneSelectIndices,
  );
  const setLaneSplitCount = useWorkflowStudioStore(
    (state) => state.setLaneSplitCount,
  );
  const setLaneZipAlignMode = useWorkflowStudioStore(
    (state) => state.setLaneZipAlignMode,
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
  const setLlmGeneratorConfigValue = useWorkflowStudioStore(
    (state) => state.setLlmGeneratorConfigValue,
  );
  const setVideoGeneratorConfigValue = useWorkflowStudioStore(
    (state) => state.setVideoGeneratorConfigValue,
  );
  const setGeneratorReviewEnabled = useWorkflowStudioStore(
    (state) => state.setGeneratorReviewEnabled,
  );

  const getGeneratorIterationInfo = useCallback((nodeId: string) => {
    const { document } = useWorkflowStudioStore.getState();
    return getGeneratorIterationPreview(document, nodeId);
  }, []);

  const getGeneratorInputs = useCallback((nodeId: string) => {
    const { document } = useWorkflowStudioStore.getState();
    return getGeneratorInputHandles(document, nodeId);
  }, []);

  const uploadFilesToNode = useCallback(
    async (nodeId: string, files: File[]) => {
      await ClientRuntime.runPromise(
        WorkflowAssetService.uploadFilesToNode(nodeId, files),
      );

      if (projectId) {
        await utils.workflow.listAssets.invalidate({ projectId });
      }
    },
    [projectId, utils],
  );

  const runNode = useCallback(async (nodeId: string) => {
    await ClientRuntime.runPromise(
      WorkflowExecutionService.run({ type: "node", nodeId }),
    );
  }, []);

  const contextValue = useMemo<StudioContextValue>(
    () => ({
      setListItems,
      setPrompt,
      setPromptDisplayMode,
      addPromptVariable,
      uploadFilesToNode,
      clearNodeAssets,
      getGeneratorInputs,
      getGeneratorIterationInfo,
      setLaneReorderMode,
      setLaneReorderOrder,
      setLaneReorderShift,
      setLaneSelectIndices,
      setLaneSplitCount,
      setLaneZipAlignMode,
      setImageGeneratorModel,
      setVideoGeneratorModel,
      setImageGeneratorMode,
      setVideoGeneratorMode,
      setImageGeneratorConfigValue,
      setLlmGeneratorConfigValue,
      setVideoGeneratorConfigValue,
      setGeneratorReviewEnabled,
      runNode,
    }),
    [
      addPromptVariable,
      clearNodeAssets,
      getGeneratorInputs,
      getGeneratorIterationInfo,
      setLaneReorderMode,
      setLaneReorderOrder,
      setLaneReorderShift,
      setLaneSelectIndices,
      setLaneSplitCount,
      setLaneZipAlignMode,
      runNode,
      setGeneratorReviewEnabled,
      setImageGeneratorConfigValue,
      setImageGeneratorMode,
      setImageGeneratorModel,
      setLlmGeneratorConfigValue,
      setPrompt,
      setPromptDisplayMode,
      setListItems,
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
