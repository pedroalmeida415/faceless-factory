"use client";

import { RiCloseLine } from "@remixicon/react";
import { memo } from "react";
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
import type {
  AssetWorkflowNode,
  ImageGeneratorWorkflowNode,
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
    case "imageGenerator":
      return {
        description: "Tune model, mode, and generation controls.",
        title: "Image Generation",
      } as const;
    case "videoGenerator":
      return {
        description: "Tune model, mode, and video generation controls.",
        title: "Video Generation",
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
          {filledItemCount > 1 ? `${filledItemCount} iterations` : "Static"}
        </p>
      </NodeFieldCard>
    </div>
  );
}

function PromptConfigPanel({ node }: { node: PromptWorkflowNode }) {
  const setPrompt = useWorkflowStudioStore((state) => state.setPrompt);

  return (
    <NodeFieldCard label="Prompt text">
      <Textarea
        className="min-h-56"
        onChange={(event) => setPrompt(node.id, event.target.value)}
        placeholder="Describe the shot, mood, framing, lens, motion."
        value={node.prompt}
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
          <Select
            onValueChange={(value) => setVideoGeneratorMode(node.id, value)}
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
                <MemoizedNodeConfigPanel node={selectedNode} />
              </div>
            </>
          ) : null}
        </DrawerContent>
      </Drawer>
    );
  },
);
