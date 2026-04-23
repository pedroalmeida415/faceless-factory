"use client";

import { useCallback, useMemo } from "react";

import {
  runNode as runWorkflowNode,
  uploadFilesToNode as uploadWorkflowFilesToNode,
} from "~/components/workflow/studio/runner";
import { ClientRuntime } from "~/effect/client/runtime";
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
      await ClientRuntime.runPromise(uploadWorkflowFilesToNode(nodeId, files));

      if (projectId) {
        await utils.workflow.listAssets.invalidate({ projectId });
      }
    },
    [projectId, utils],
  );

  const runNode = useCallback(async (nodeId: string) => {
    await ClientRuntime.runPromise(runWorkflowNode(nodeId));
  }, []);

  const contextValue = useMemo<StudioContextValue>(
    () => ({
      setPrompt,
      setPromptDisplayMode,
      addPromptVariable,
      uploadFilesToNode,
      clearNodeAssets,
      getGeneratorInputs,
      getGeneratorIterationInfo,
      setImageGeneratorModel,
      setVideoGeneratorModel,
      setImageGeneratorMode,
      setVideoGeneratorMode,
      setImageGeneratorConfigValue,
      setLlmGeneratorConfigValue,
      setVideoGeneratorConfigValue,
      runNode,
    }),
    [
      addPromptVariable,
      clearNodeAssets,
      getGeneratorInputs,
      getGeneratorIterationInfo,
      runNode,
      setImageGeneratorConfigValue,
      setImageGeneratorMode,
      setImageGeneratorModel,
      setLlmGeneratorConfigValue,
      setPrompt,
      setPromptDisplayMode,
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
