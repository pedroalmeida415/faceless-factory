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
  const setOutputReorderMode = useWorkflowStudioStore(
    (state) => state.setOutputReorderMode,
  );
  const setOutputReorderOrder = useWorkflowStudioStore(
    (state) => state.setOutputReorderOrder,
  );
  const setOutputReorderShift = useWorkflowStudioStore(
    (state) => state.setOutputReorderShift,
  );
  const setOutputSelectIndices = useWorkflowStudioStore(
    (state) => state.setOutputSelectIndices,
  );
  const setOutputSplitCount = useWorkflowStudioStore(
    (state) => state.setOutputSplitCount,
  );
  const setOutputZipAlignMode = useWorkflowStudioStore(
    (state) => state.setOutputZipAlignMode,
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
      WorkflowExecutionService.start({ type: "node", nodeId }),
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
      setOutputReorderMode,
      setOutputReorderOrder,
      setOutputReorderShift,
      setOutputSelectIndices,
      setOutputSplitCount,
      setOutputZipAlignMode,
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
      setOutputReorderMode,
      setOutputReorderOrder,
      setOutputReorderShift,
      setOutputSelectIndices,
      setOutputSplitCount,
      setOutputZipAlignMode,
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
