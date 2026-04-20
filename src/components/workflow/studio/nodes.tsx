"use client";

import { useEffect } from "react";
import { type NodeProps, useUpdateNodeInternals } from "reactflow";
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
  type GeneratorControlDefinition,
  getImageGeneratorControlDefinitions,
  getImageGeneratorModelOptions,
  getImageGeneratorModeOptions,
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

function PromptNode({ id, data, selected }: NodeProps<PromptNodeData>) {
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
}

function AssetNode({ id, data, selected }: NodeProps<AssetNodeData>) {
  const { uploadFilesToNode, clearNodeAssets } = useStudioContext();
  const assetKindLabel = data.assetKind ? capitalize(data.assetKind) : "Asset";
  const outputColor =
    data.assetKind === "image"
      ? "#38bdf8"
      : data.assetKind === "video"
        ? "#818cf8"
        : "#94a3b8";
  const accept = data.assetKind ? `${data.assetKind}/*` : "image/*,video/*";
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
}

function GeneratorControlGrid({
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

function ImageGeneratorNode({
  id,
  data,
  selected,
}: NodeProps<ImageGeneratorNodeData>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const {
    getGeneratorInputs,
    getGeneratorIterationInfo,
    setImageGeneratorConfigValue,
    setImageGeneratorMode,
    setImageGeneratorModel,
    runNode,
  } = useStudioContext();
  const inputs = getGeneratorInputs(id);
  const inputHandleSignature = inputs.map((handle) => handle.id).join("|");
  const iterationInfo = getGeneratorIterationInfo(id);
  const modelOptions = getImageGeneratorModelOptions();
  const modeOptions = getImageGeneratorModeOptions(data.model);
  const controls = getImageGeneratorControlDefinitions(data.model, data.mode);

  useEffect(() => {
    inputHandleSignature;
    updateNodeInternals(id);
  }, [id, inputHandleSignature, updateNodeInternals]);

  return (
    <NodeShell
      data={data}
      id={id}
      inputs={inputs}
      output={{ id: "images", label: "Images", color: "#22c55e" }}
      selected={selected}
    >
      <div className="grid gap-2">
        <NodeFieldCard label="Model">
          <Select
            onValueChange={(value) =>
              setImageGeneratorModel(id, value as typeof data.model)
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
              onValueChange={(value) => setImageGeneratorMode(id, value)}
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
          setImageGeneratorConfigValue(id, key, value)
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
        Run image generation
      </ShellButton>

      {data.responseText ? (
        <NodeFieldCard label="Model note">
          <p>{data.responseText}</p>
        </NodeFieldCard>
      ) : null}

      <OutputGallery assets={data.outputAssets} />
    </NodeShell>
  );
}

function VideoGeneratorNode({
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
}

export const nodeTypes = {
  prompt: PromptNode,
  asset: AssetNode,
  imageGenerator: ImageGeneratorNode,
  videoGenerator: VideoGeneratorNode,
};
