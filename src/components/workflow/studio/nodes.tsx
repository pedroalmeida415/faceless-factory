"use client";

import { memo, useEffect } from "react";
import { type NodeProps, useUpdateNodeInternals } from "reactflow";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import {
  WORKFLOW_ASSET_UPLOAD_ACCEPT,
  WORKFLOW_IMAGE_UPLOAD_ACCEPT,
  WORKFLOW_VIDEO_UPLOAD_ACCEPT,
} from "~/lib/workflow/assets";
import {
  type GeneratorControlDefinition,
  getImageGeneratorControlDefinitions,
  getImageGeneratorModelOptions,
  getVideoGeneratorControlDefinitions,
  getVideoGeneratorModelOptions,
  getVideoGeneratorModeOptions,
} from "~/lib/workflow/generator-models";
import type {
  AssetNodeData,
  GeneratorConfigValue,
  ImageGeneratorNodeData,
  PromptNodeData,
  VideoGeneratorNodeData,
  WorkflowNodeData,
} from "~/lib/workflow/types";
import { useStudioContext } from "./context";
import {
  FilePickerButton,
  NodeFieldCard,
  NodeNotice,
  NodeShell,
  OutputGallery,
  ShellButton,
} from "./shared";

function capitalize(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function coerceConfigValue(
  currentValue: GeneratorConfigValue,
  nextValue: string,
): GeneratorConfigValue {
  if (typeof currentValue === "number") {
    return Number(nextValue);
  }

  return nextValue;
}

function formatCredits(value: number) {
  return `${value} credit${value === 1 ? "" : "s"}`;
}

function isSameNodeRender<T extends WorkflowNodeData>(
  previousProps: NodeProps<T>,
  nextProps: NodeProps<T>,
) {
  return (
    previousProps.id === nextProps.id &&
    previousProps.selected === nextProps.selected &&
    previousProps.data === nextProps.data
  );
}

function GeneratorRunCostBadge({ nodeId }: { nodeId: string }) {
  const { getGeneratorRunCost } = useStudioContext();
  const priceQuote = getGeneratorRunCost(nodeId);

  if (!priceQuote || priceQuote.totalCost <= 0) {
    return null;
  }

  return (
    <Badge
      className="border-primary/20 bg-primary/10 text-primary"
      title={
        priceQuote.lineItems.length > 1
          ? "Includes upstream generator costs."
          : undefined
      }
      variant="outline"
    >
      {`${formatCredits(priceQuote.totalCost)} / run`}
    </Badge>
  );
}

const PromptNode = memo(function PromptNode({
  id,
  data,
  selected,
}: NodeProps<PromptNodeData>) {
  const { setPrompt } = useStudioContext();

  return (
    <NodeShell
      data={data}
      id={id}
      output={{ id: "text", label: "Text", color: "#f59e0b" }}
      selected={selected}
    >
      <Textarea
        className="min-h-40"
        onChange={(event) => setPrompt(id, event.target.value)}
        placeholder="Describe the shot, mood, framing, lens, motion."
        value={data.prompt}
      />
    </NodeShell>
  );
}, isSameNodeRender);

const AssetNode = memo(function AssetNode({
  id,
  data,
  selected,
}: NodeProps<AssetNodeData>) {
  const { uploadFilesToNode, clearNodeAssets } = useStudioContext();
  const assetKindLabel = data.assetKind ? capitalize(data.assetKind) : "Asset";
  const outputColor =
    data.assetKind === "image"
      ? "#38bdf8"
      : data.assetKind === "video"
        ? "#818cf8"
        : "#94a3b8";
  const accept =
    data.assetKind === "image"
      ? WORKFLOW_IMAGE_UPLOAD_ACCEPT
      : data.assetKind === "video"
        ? WORKFLOW_VIDEO_UPLOAD_ACCEPT
        : WORKFLOW_ASSET_UPLOAD_ACCEPT;
  const uploadLabel = data.assets.length
    ? `Add more ${data.assetKind ?? "assets"}`
    : data.assetKind
      ? `Upload ${data.assetKind}`
      : "Upload media";

  return (
    <NodeShell
      data={data}
      id={id}
      output={{ id: "asset", label: assetKindLabel, color: outputColor }}
      selected={selected}
    >
      {data.assets.length ? <OutputGallery assets={data.assets} /> : null}

      {!data.assets.length && data.assetKind ? (
        <Card className="border-dashed py-0">
          <CardContent className="py-8 text-muted-foreground text-sm">
            Type locked to {data.assetKind}. Upload more to reuse this node.
          </CardContent>
        </Card>
      ) : null}

      {!data.assets.length && !data.assetKind ? (
        <Card className="border-dashed py-0">
          <CardContent className="py-8 text-muted-foreground text-sm">
            One asset node now covers both static files and iterator batches.
          </CardContent>
        </Card>
      ) : null}

      <div className="flex items-center gap-2">
        <FilePickerButton
          accept={accept}
          label={uploadLabel}
          multiple
          onFiles={(files) => void uploadFilesToNode(id, files)}
        />
        {data.assets.length ? (
          <ShellButton onClick={() => clearNodeAssets(id)}>Clear</ShellButton>
        ) : null}
      </div>
    </NodeShell>
  );
}, isSameNodeRender);

export function GeneratorControlGrid({
  controls,
  config,
  onConfigChange,
}: {
  controls: readonly GeneratorControlDefinition[];
  config: Record<string, GeneratorConfigValue>;
  onConfigChange: (key: string, value: GeneratorConfigValue) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {controls.map((control) => {
        if (control.type === "switch") {
          return (
            <NodeFieldCard key={control.key} label={control.label}>
              <div className="flex items-center justify-between">
                <span className="text-sm">{control.label}</span>
                <Switch
                  checked={Boolean(config[control.key])}
                  onCheckedChange={(checked) =>
                    onConfigChange(control.key, checked)
                  }
                />
              </div>
            </NodeFieldCard>
          );
        }

        return (
          <NodeFieldCard key={control.key} label={control.label}>
            <Select
              onValueChange={(value) =>
                onConfigChange(
                  control.key,
                  coerceConfigValue(config[control.key] ?? null, value),
                )
              }
              value={String(
                config[control.key] ?? control.options[0]?.value ?? "",
              )}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {control.options.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </NodeFieldCard>
        );
      })}
    </div>
  );
}

const ImageGeneratorNode = memo(function ImageGeneratorNode({
  id,
  data,
  selected,
}: NodeProps<ImageGeneratorNodeData>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const { getGeneratorInputs, getGeneratorIterationInfo, runNode } =
    useStudioContext();
  const inputs = getGeneratorInputs(id);
  const inputHandleSignature = inputs.map((handle) => handle.id).join("|");
  const iterationInfo = getGeneratorIterationInfo(id);
  const modelOptions = getImageGeneratorModelOptions();
  const controls = getImageGeneratorControlDefinitions(data.model, data.mode);
  const modelLabel =
    modelOptions.find((option) => option.value === data.model)?.label ??
    data.model;
  const aspectRatioControl = controls.find(
    (
      control,
    ): control is Extract<GeneratorControlDefinition, { type: "select" }> =>
      control.type === "select" && control.key === "aspectRatio",
  );
  const aspectRatio =
    typeof data.config.aspectRatio === "string"
      ? data.config.aspectRatio
      : (aspectRatioControl?.options[0]?.value ?? "1:1");

  useEffect(() => {
    inputHandleSignature;
    updateNodeInternals(id);
  }, [id, inputHandleSignature, updateNodeInternals]);

  return (
    <NodeShell
      data={{ ...data, label: "Image Gen" }}
      headerDetail={<GeneratorRunCostBadge nodeId={id} />}
      id={id}
      inputs={inputs}
      output={{ id: "images", label: "Images", color: "#22c55e" }}
      selected={selected}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          className="border-border/70 bg-muted/50 text-foreground"
          variant="outline"
        >
          {modelLabel}
        </Badge>
        <Badge
          className="border-border/70 bg-muted/50 text-foreground"
          variant="outline"
        >
          {`Aspect ${aspectRatio}`}
        </Badge>
      </div>

      {iterationInfo.hasIterator ? (
        <NodeNotice tone="accent">
          {`Will run ${iterationInfo.iterations} iteration${iterationInfo.iterations === 1 ? "" : "s"}. Click here to visualize combinations`}
        </NodeNotice>
      ) : null}

      <OutputGallery assets={data.outputAssets} />

      <ShellButton
        className="w-full justify-center"
        onClick={() => void runNode(id)}
      >
        Run image generation
      </ShellButton>
    </NodeShell>
  );
}, isSameNodeRender);

const VideoGeneratorNode = memo(function VideoGeneratorNode({
  id,
  data,
  selected,
}: NodeProps<VideoGeneratorNodeData>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const {
    getGeneratorInputs,
    getGeneratorIterationInfo,
    setVideoGeneratorConfigValue,
    setVideoGeneratorMode,
    setVideoGeneratorModel,
    runNode,
  } = useStudioContext();
  const inputs = getGeneratorInputs(id);
  const inputHandleSignature = inputs.map((handle) => handle.id).join("|");
  const iterationInfo = getGeneratorIterationInfo(id);
  const modelOptions = getVideoGeneratorModelOptions();
  const modeOptions = getVideoGeneratorModeOptions(data.model);
  const controls = getVideoGeneratorControlDefinitions(data.model, data.mode);

  useEffect(() => {
    inputHandleSignature;
    updateNodeInternals(id);
  }, [id, inputHandleSignature, updateNodeInternals]);

  return (
    <NodeShell
      data={data}
      headerDetail={<GeneratorRunCostBadge nodeId={id} />}
      id={id}
      inputs={inputs}
      output={{ id: "videos", label: "Videos", color: "#a78bfa" }}
      selected={selected}
    >
      <div className="grid gap-2">
        <NodeFieldCard label="Model">
          <Select
            onValueChange={(value) =>
              setVideoGeneratorModel(id, value as typeof data.model)
            }
            value={data.model}
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
              onValueChange={(value) => setVideoGeneratorMode(id, value)}
              value={data.mode ?? modeOptions[0]?.value}
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
      </div>

      <GeneratorControlGrid
        config={data.config}
        controls={controls}
        onConfigChange={(key, value) =>
          setVideoGeneratorConfigValue(id, key, value)
        }
      />

      {iterationInfo.hasIterator ? (
        <NodeNotice tone="accent">
          {`Will run ${iterationInfo.iterations} iteration${iterationInfo.iterations === 1 ? "" : "s"}. Click here to visualize combinations`}
        </NodeNotice>
      ) : null}

      <ShellButton
        className="w-full justify-center"
        onClick={() => void runNode(id)}
      >
        Run video generation
      </ShellButton>

      <OutputGallery assets={data.outputAssets} />
    </NodeShell>
  );
}, isSameNodeRender);

export const nodeTypes = {
  prompt: PromptNode,
  asset: AssetNode,
  imageGenerator: ImageGeneratorNode,
  videoGenerator: VideoGeneratorNode,
};
