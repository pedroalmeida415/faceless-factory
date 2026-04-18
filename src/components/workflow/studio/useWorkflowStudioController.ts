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
  const setPrompt = useWorkflowStudioStore((state) => state.setPrompt);
  const clearNodeAssets = useWorkflowStudioStore(
    (state) => state.clearNodeAssets,
  );
  const setImageGeneratorAspectRatio = useWorkflowStudioStore(
    (state) => state.setImageGeneratorAspectRatio,
  );
  const setVideoGeneratorAspectRatio = useWorkflowStudioStore(
    (state) => state.setVideoGeneratorAspectRatio,
  );
  const setVideoGeneratorDuration = useWorkflowStudioStore(
    (state) => state.setVideoGeneratorDuration,
  );
  const setVideoGeneratorResolution = useWorkflowStudioStore(
    (state) => state.setVideoGeneratorResolution,
  );
  const setVideoGeneratorGenerateAudio = useWorkflowStudioStore(
    (state) => state.setVideoGeneratorGenerateAudio,
  );

  const getGeneratorIterationInfo = useCallback((nodeId: string) => {
    const { document } = useWorkflowStudioStore.getState();
    return getGeneratorIterationPreview(document, nodeId);
  }, []);

  const getGeneratorImageInputs = useCallback((nodeId: string) => {
    const { document } = useWorkflowStudioStore.getState();
    return getGeneratorImageInputHandles(document.edges, nodeId);
  }, []);

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
      setPrompt,
      uploadFilesToNode,
      clearNodeAssets,
      getGeneratorImageInputs,
      getGeneratorIterationInfo,
      setImageGeneratorAspectRatio,
      setVideoGeneratorAspectRatio,
      setVideoGeneratorDuration,
      setVideoGeneratorResolution,
      setVideoGeneratorGenerateAudio,
      runNode,
    }),
    [
      clearNodeAssets,
      getGeneratorImageInputs,
      getGeneratorIterationInfo,
      runNode,
      setImageGeneratorAspectRatio,
      setPrompt,
      setVideoGeneratorAspectRatio,
      setVideoGeneratorDuration,
      setVideoGeneratorGenerateAudio,
      setVideoGeneratorResolution,
      uploadFilesToNode,
    ],
  );

  return {
    contextValue,
    runSelectedOrAll,
  };
}
