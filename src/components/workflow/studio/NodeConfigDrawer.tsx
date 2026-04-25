"use client";

import { RiCloseLine } from "@remixicon/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "~/components/ui/drawer";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import type {
  AssetWorkflowNode,
  ImageGeneratorWorkflowNode,
  LaneReorderWorkflowNode,
  ListWorkflowNode,
  LlmGeneratorWorkflowNode,
  PromptWorkflowNode,
  VideoGeneratorWorkflowNode,
  WorkflowDocumentNode,
} from "~/lib/workflow/document";
import {
  getImageGeneratorControlDefinitions,
  getImageGeneratorModelOptions,
  getImageGeneratorModeOptions,
  getVideoGeneratorControlDefinitions,
  getVideoGeneratorModelOptions,
  getVideoGeneratorModeOptions,
} from "~/lib/workflow/generator-models";
import {
  getLlmGeneratorControlDefinitions,
  getLlmGeneratorModelOptions,
} from "~/lib/workflow/llm-models";
import {
  GeneratorControlGrid,
  ListItemsEditor,
  WorkflowExecutionEstimateWarning,
} from "./nodes";
import { NodeFieldCard, ShellButton } from "./shared";
import { useWorkflowStudioStore } from "./store";
import { useWorkflowExecutionQuote } from "./useWorkflowExecutionQuote";

function formatCredits(value: number) {
  return `${value} credit${value === 1 ? "" : "s"}`;
}

const TEXT_INPUT_COMMIT_DELAY_MS = 150;

function useBufferedTextInput(
  value: string,
  onCommit: (value: string) => void,
) {
  const [draftValue, setDraftValue] = useState(value);
  const commitTimerRef = useRef<number | null>(null);
  const focusedRef = useRef(false);
  const lastValueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  const pendingValueRef = useRef<string | null>(null);
  // Stale store updates can arrive before the committed draft echoes back.
  const pendingPropValueRef = useRef<string | null>(null);

  onCommitRef.current = onCommit;

  const clearCommitTimer = useCallback(() => {
    if (commitTimerRef.current === null) {
      return;
    }

    window.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
  }, []);

  const flushValue = useCallback(() => {
    const pendingValue = pendingValueRef.current;
    if (pendingValue === null) {
      return;
    }

    pendingValueRef.current = null;
    clearCommitTimer();

    if (pendingValue === lastValueRef.current) {
      pendingPropValueRef.current = null;
      return;
    }

    pendingPropValueRef.current = pendingValue;
    onCommitRef.current(pendingValue);
  }, [clearCommitTimer]);

  const setValue = useCallback(
    (nextValue: string) => {
      setDraftValue(nextValue);
      clearCommitTimer();

      if (nextValue === lastValueRef.current) {
        pendingValueRef.current = null;
        pendingPropValueRef.current = null;
        return;
      }

      pendingValueRef.current = nextValue;
      pendingPropValueRef.current = nextValue;
      if (focusedRef.current) {
        return;
      }

      commitTimerRef.current = window.setTimeout(
        flushValue,
        TEXT_INPUT_COMMIT_DELAY_MS,
      );
    },
    [clearCommitTimer, flushValue],
  );

  useEffect(() => {
    if (value === lastValueRef.current) {
      return;
    }

    lastValueRef.current = value;

    if (pendingValueRef.current === value) {
      pendingValueRef.current = null;
      pendingPropValueRef.current = null;
      clearCommitTimer();
      return;
    }

    if (pendingPropValueRef.current === value) {
      pendingPropValueRef.current = null;
      return;
    }

    if (
      pendingValueRef.current !== null ||
      pendingPropValueRef.current !== null
    ) {
      return;
    }

    setDraftValue(value);
  }, [clearCommitTimer, value]);

  useEffect(() => () => flushValue(), [flushValue]);

  const handleFocus = useCallback(() => {
    focusedRef.current = true;
    clearCommitTimer();
  }, [clearCommitTimer]);

  const handleBlur = useCallback(() => {
    focusedRef.current = false;
    flushValue();
  }, [flushValue]);

  return [draftValue, setValue, handleFocus, handleBlur] as const;
}

function getSelectedNode(nodeIds: string[], nodes: WorkflowDocumentNode[]) {
  for (let index = nodeIds.length - 1; index >= 0; index -= 1) {
    const selectedNodeId = nodeIds[index];
    const node = nodes.find((candidate) => candidate.id === selectedNodeId);
    if (node) {
      return node;
    }
  }

  return null;
}

function getDrawerHeading(node: WorkflowDocumentNode) {
  switch (node.kind) {
    case "list":
      return {
        description: "Manage literal text list items for this workflow branch.",
        title: "List",
      } as const;
    case "prompt":
      return {
        description: "Write the upstream text payload used by generators.",
        title: "Prompt",
      } as const;
    case "asset":
      return {
        description: "Manage uploaded source media for this workflow branch.",
        title: "Asset",
      } as const;
    case "laneReorder":
      return {
        description:
          "Reorder lanes on this branch without mutating upstream output.",
        title: "Lane Reorder",
      } as const;
    case "imageGenerator":
      return {
        description: "Tune model, mode, and generation controls.",
        title: "Image Generation",
      } as const;
    case "videoGenerator":
      return {
        description: "Choose a video mode and tune model generation controls.",
        title: "Video Gen",
      } as const;
    case "llmGenerator":
      return {
        description: "Tune prompt execution controls for the Gemini LLM node.",
        title: "Run Any LLM",
      } as const;
  }
}

function ListConfigPanel({ node }: { node: ListWorkflowNode }) {
  const setListItems = useWorkflowStudioStore((state) => state.setListItems);
  const items = node.items.length ? node.items : [""];
  const filledItemCount = items.filter((item) => item.trim()).length;

  return (
    <div className="space-y-3">
      <ListItemsEditor
        items={items}
        nodeId={node.id}
        onItemsChange={(nextItems) => setListItems(node.id, nextItems)}
      />
      <NodeFieldCard label="Iteration">
        <p className="text-sm">
          {filledItemCount > 1 ? `${filledItemCount} lanes` : "1 lane"}
        </p>
      </NodeFieldCard>
    </div>
  );
}

function PromptConfigPanel({ node }: { node: PromptWorkflowNode }) {
  const setPrompt = useWorkflowStudioStore((state) => state.setPrompt);
  const commitPrompt = useCallback(
    (prompt: string) => setPrompt(node.id, prompt),
    [node.id, setPrompt],
  );
  const [prompt, setPromptDraft, focusPrompt, blurPrompt] =
    useBufferedTextInput(node.prompt, commitPrompt);

  return (
    <NodeFieldCard label="Prompt text">
      <Textarea
        className="min-h-56"
        onBlur={blurPrompt}
        onChange={(event) => setPromptDraft(event.target.value)}
        onFocus={focusPrompt}
        placeholder="Describe the shot, mood, framing, lens, motion."
        value={prompt}
      />
    </NodeFieldCard>
  );
}

function AssetConfigPanel({ node }: { node: AssetWorkflowNode }) {
  const clearNodeAssets = useWorkflowStudioStore(
    (state) => state.clearNodeAssets,
  );

  return (
    <div className="space-y-3">
      <NodeFieldCard label="Detected kind">
        <p className="text-sm">
          {node.assetKind
            ? `${node.assetKind.slice(0, 1).toUpperCase()}${node.assetKind.slice(1)}`
            : "Auto (set when files are uploaded)"}
        </p>
      </NodeFieldCard>
      <NodeFieldCard label="Assets loaded">
        <p className="text-sm">{`${node.assets.length} file${node.assets.length === 1 ? "" : "s"}`}</p>
      </NodeFieldCard>
      {node.assets.length ? (
        <ShellButton
          className="w-full justify-center"
          onClick={() => clearNodeAssets(node.id)}
        >
          Clear assets
        </ShellButton>
      ) : null}
    </div>
  );
}

function LaneReorderConfigPanel({ node }: { node: LaneReorderWorkflowNode }) {
  return (
    <NodeFieldCard label="Inline settings">
      <p className="text-sm">
        Adjust {node.label} directly on the node card. Its lane type is inferred
        from the connected input and resets when disconnected.
      </p>
    </NodeFieldCard>
  );
}

function ImageGeneratorConfigPanel({
  node,
}: {
  node: ImageGeneratorWorkflowNode;
}) {
  const setImageGeneratorModel = useWorkflowStudioStore(
    (state) => state.setImageGeneratorModel,
  );
  const setImageGeneratorMode = useWorkflowStudioStore(
    (state) => state.setImageGeneratorMode,
  );
  const setImageGeneratorConfigValue = useWorkflowStudioStore(
    (state) => state.setImageGeneratorConfigValue,
  );
  const modelOptions = getImageGeneratorModelOptions();
  const modeOptions = getImageGeneratorModeOptions(node.model);
  const controls = getImageGeneratorControlDefinitions(node.model, node.mode);

  return (
    <div className="space-y-3">
      <NodeFieldCard label="Model">
        <Select
          onValueChange={(value) =>
            setImageGeneratorModel(node.id, value as typeof node.model)
          }
          value={node.model}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </NodeFieldCard>

      {modeOptions.length > 1 ? (
        <NodeFieldCard label="Mode">
          <Select
            onValueChange={(value) => setImageGeneratorMode(node.id, value)}
            value={node.mode ?? modeOptions[0]?.value}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </NodeFieldCard>
      ) : null}

      <GeneratorControlGrid
        config={node.config}
        controls={controls}
        onConfigChange={(key, value) =>
          setImageGeneratorConfigValue(node.id, key, value)
        }
      />
    </div>
  );
}

function VideoGeneratorConfigPanel({
  node,
}: {
  node: VideoGeneratorWorkflowNode;
}) {
  const setVideoGeneratorModel = useWorkflowStudioStore(
    (state) => state.setVideoGeneratorModel,
  );
  const setVideoGeneratorMode = useWorkflowStudioStore(
    (state) => state.setVideoGeneratorMode,
  );
  const setVideoGeneratorConfigValue = useWorkflowStudioStore(
    (state) => state.setVideoGeneratorConfigValue,
  );
  const modelOptions = getVideoGeneratorModelOptions();
  const modeOptions = getVideoGeneratorModeOptions(node.model);
  const selectedMode = node.mode ?? modeOptions[0]?.value;
  const controls = getVideoGeneratorControlDefinitions(node.model, node.mode);

  return (
    <div className="space-y-3">
      <NodeFieldCard label="Model">
        <Select
          onValueChange={(value) =>
            setVideoGeneratorModel(node.id, value as typeof node.model)
          }
          value={node.model}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </NodeFieldCard>

      {modeOptions.length > 1 ? (
        <NodeFieldCard label="Mode">
          <div
            aria-label="Video generation mode"
            className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
            role="tablist"
          >
            {modeOptions.map((option) => {
              const active = option.value === selectedMode;

              return (
                <button
                  aria-selected={active}
                  className={cn(
                    "rounded-md px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                  key={option.value}
                  onClick={() => setVideoGeneratorMode(node.id, option.value)}
                  role="tab"
                  type="button"
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </NodeFieldCard>
      ) : null}

      <GeneratorControlGrid
        config={node.config}
        controls={controls}
        onConfigChange={(key, value) =>
          setVideoGeneratorConfigValue(node.id, key, value)
        }
      />
    </div>
  );
}

function LlmEstimatePanel({ nodeId }: { nodeId: string }) {
  const { priceQuote } = useWorkflowExecutionQuote(nodeId);

  return (
    <NodeFieldCard label="Estimated cost">
      <p className="text-sm">
        {priceQuote
          ? `${priceQuote.hasEstimate ? "~" : ""}${formatCredits(priceQuote.totalCost)} per run`
          : "Unavailable"}
      </p>
    </NodeFieldCard>
  );
}

function LlmGeneratorConfigPanel({ node }: { node: LlmGeneratorWorkflowNode }) {
  const setLlmGeneratorConfigValue = useWorkflowStudioStore(
    (state) => state.setLlmGeneratorConfigValue,
  );
  const modelLabel =
    getLlmGeneratorModelOptions().find((option) => option.value === node.model)
      ?.label ?? node.model;

  return (
    <div className="space-y-3">
      <NodeFieldCard label="Model">
        <p className="text-sm">{modelLabel}</p>
      </NodeFieldCard>

      <GeneratorControlGrid
        config={node.config}
        controls={getLlmGeneratorControlDefinitions(node.model)}
        onConfigChange={(key, value) =>
          setLlmGeneratorConfigValue(node.id, key, value)
        }
      />

      <LlmEstimatePanel nodeId={node.id} />
      <WorkflowExecutionEstimateWarning nodeId={node.id} />
    </div>
  );
}

function NodeConfigPanel({ node }: { node: WorkflowDocumentNode }) {
  switch (node.kind) {
    case "list":
      return <ListConfigPanel node={node} />;
    case "prompt":
      return <PromptConfigPanel node={node} />;
    case "asset":
      return <AssetConfigPanel node={node} />;
    case "laneReorder":
      return <LaneReorderConfigPanel node={node} />;
    case "imageGenerator":
      return <ImageGeneratorConfigPanel node={node} />;
    case "videoGenerator":
      return <VideoGeneratorConfigPanel node={node} />;
    case "llmGenerator":
      return <LlmGeneratorConfigPanel node={node} />;
  }
}

function isSameNodeConfig(
  left: WorkflowDocumentNode,
  right: WorkflowDocumentNode,
) {
  if (left.id !== right.id || left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "list":
      return right.kind === "list" && left.items === right.items;
    case "prompt":
      return (
        right.kind === "prompt" &&
        left.prompt === right.prompt &&
        left.displayMode === right.displayMode &&
        left.variables === right.variables
      );
    case "asset":
      return (
        right.kind === "asset" &&
        left.assetKind === right.assetKind &&
        left.assets === right.assets
      );
    case "laneReorder":
      return (
        right.kind === "laneReorder" &&
        left.mode === right.mode &&
        left.order === right.order &&
        left.shift === right.shift &&
        left.valueType === right.valueType
      );
    case "imageGenerator":
      return (
        right.kind === "imageGenerator" &&
        left.model === right.model &&
        left.mode === right.mode &&
        left.config === right.config
      );
    case "videoGenerator":
      return (
        right.kind === "videoGenerator" &&
        left.model === right.model &&
        left.mode === right.mode &&
        left.config === right.config
      );
    case "llmGenerator":
      return (
        right.kind === "llmGenerator" &&
        left.model === right.model &&
        left.mode === right.mode &&
        left.config === right.config &&
        left.responseText === right.responseText
      );
  }
}

const MemoizedNodeConfigPanel = memo(
  NodeConfigPanel,
  (previousProps, nextProps) =>
    isSameNodeConfig(previousProps.node, nextProps.node),
);

export const WorkflowNodeConfigDrawer = memo(
  function WorkflowNodeConfigDrawer() {
    const selectedNode = useWorkflowStudioStore((state) =>
      getSelectedNode(state.editor.selectedNodeIds, state.document.nodes),
    );
    const clearSelection = useWorkflowStudioStore(
      (state) => state.clearSelection,
    );
    const drawerHeading = selectedNode ? getDrawerHeading(selectedNode) : null;

    return (
      <Drawer
        direction="right"
        modal={false}
        onOpenChange={(open) => {
          if (!open) {
            clearSelection();
          }
        }}
        open={Boolean(selectedNode)}
      >
        <DrawerContent className="h-screen rounded-none border-border/60 border-l bg-background/95 p-0 before:hidden data-[vaul-drawer-direction=right]:w-full data-[vaul-drawer-direction=right]:max-w-[420px]">
          {selectedNode ? (
            <>
              <DrawerHeader className="border-border/60 border-b px-5 py-4 text-left">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <DrawerTitle>{drawerHeading?.title}</DrawerTitle>
                    <DrawerDescription>
                      {drawerHeading?.description}
                    </DrawerDescription>
                  </div>
                  <DrawerClose asChild>
                    <ShellButton
                      aria-label="Close node configuration"
                      className="size-8 p-0"
                      size="icon"
                      title="Close"
                    >
                      <RiCloseLine className="size-4" />
                    </ShellButton>
                  </DrawerClose>
                </div>
              </DrawerHeader>
              <div className="nodrag nopan nowheel flex-1 overflow-y-auto px-5 py-4">
                <MemoizedNodeConfigPanel
                  key={selectedNode.id}
                  node={selectedNode}
                />
              </div>
            </>
          ) : null}
        </DrawerContent>
      </Drawer>
    );
  },
);
