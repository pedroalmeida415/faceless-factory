"use client";

import { useEffect } from "react";
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
  IMAGE_ASPECT_RATIOS,
  type ImageAspectRatio,
  type ImageGeneratorNodeData,
  type ImageIteratorNodeData,
  type ImageNodeData,
  type PromptNodeData,
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS,
  VIDEO_RESOLUTIONS,
  type VideoAspectRatio,
  type VideoDuration,
  type VideoGeneratorNodeData,
  type VideoNodeData,
  type VideoResolution,
} from "~/lib/workflow/types";
import { useStudioContext } from "./context";
import { PROMPT_INPUT_HANDLE_ID } from "./graph";
import {
  AssetPreview,
  FilePickerButton,
  NodeShell,
  OutputGallery,
  ShellButton,
} from "./shared";

function PromptNode({ id, data, selected }: NodeProps<PromptNodeData>) {
  const { setPrompt } = useStudioContext();

  return (
    <NodeShell
      data={data}
      icon="TXT"
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

function ImageUploadNode({ id, data, selected }: NodeProps<ImageNodeData>) {
  const { uploadFilesToNode, clearNodeAssets } = useStudioContext();

  return (
    <NodeShell
      data={data}
      icon="IMG"
      output={{ id: "image", label: "Image", color: "#38bdf8" }}
      selected={selected}
    >
      <div className="space-y-3">
        {data.asset ? (
          <Card className="gap-0 overflow-hidden py-0">
            <div className="aspect-[4/3]">
              <AssetPreview asset={data.asset} />
            </div>
            <CardContent className="flex items-center justify-between border-t px-3 py-3 text-xs">
              <span className="truncate">{data.asset.fileName}</span>
              <ShellButton
                className="px-2 py-1 text-xs"
                onClick={() => clearNodeAssets(id)}
              >
                Clear
              </ShellButton>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-dashed py-0">
            <CardContent className="py-8 text-muted-foreground text-sm">
            Single image input. Connect into generators or feed your iterator
            later.
            </CardContent>
          </Card>
        )}
        <FilePickerButton
          accept="image/*"
          label={data.asset ? "Replace image" : "Upload image"}
          onFiles={(files) =>
            void uploadFilesToNode(id, files, {
              kind: "image",
              multiple: false,
            })
          }
        />
      </div>
    </NodeShell>
  );
}

function VideoUploadNode({ id, data, selected }: NodeProps<VideoNodeData>) {
  const { uploadFilesToNode, clearNodeAssets } = useStudioContext();

  return (
    <NodeShell
      data={data}
      icon="VID"
      output={{ id: "video", label: "Video", color: "#818cf8" }}
      selected={selected}
    >
      <div className="space-y-3">
        {data.asset ? (
          <Card className="gap-0 overflow-hidden py-0">
            <div className="aspect-video">
              <AssetPreview asset={data.asset} />
            </div>
            <CardContent className="flex items-center justify-between border-t px-3 py-3 text-xs">
              <span className="truncate">{data.asset.fileName}</span>
              <ShellButton
                className="px-2 py-1 text-xs"
                onClick={() => clearNodeAssets(id)}
              >
                Clear
              </ShellButton>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-dashed py-0">
            <CardContent className="py-8 text-muted-foreground text-sm">
            Local video node for uploads, references, or future downstream
            processing.
            </CardContent>
          </Card>
        )}
        <FilePickerButton
          accept="video/*"
          label={data.asset ? "Replace video" : "Upload video"}
          onFiles={(files) =>
            void uploadFilesToNode(id, files, {
              kind: "video",
              multiple: false,
            })
          }
        />
      </div>
    </NodeShell>
  );
}

function ImageIteratorNode({
  id,
  data,
  selected,
}: NodeProps<ImageIteratorNodeData>) {
  const { uploadFilesToNode, clearNodeAssets } = useStudioContext();

  return (
    <NodeShell
      data={data}
      icon="SET"
      output={{ id: "images", label: "Images", color: "#38bdf8" }}
      selected={selected}
    >
      <Card className="py-0">
        <CardContent className="py-3 text-muted-foreground text-sm">
        {data.assets.length
          ? `${data.assets.length} queued reference image${data.assets.length === 1 ? "" : "s"}`
          : "Upload multiple images. When this feeds a generator, the runner fans out one job per image."}
        </CardContent>
      </Card>
      {data.assets.length ? <OutputGallery assets={data.assets} /> : null}
      <div className="flex items-center gap-2">
        <FilePickerButton
          accept="image/*"
          label={data.assets.length ? "Add more images" : "Upload batch"}
          multiple
          onFiles={(files) =>
            void uploadFilesToNode(id, files, { kind: "image", multiple: true })
          }
        />
        {data.assets.length ? (
          <ShellButton onClick={() => clearNodeAssets(id)}>
            Clear batch
          </ShellButton>
        ) : null}
      </div>
    </NodeShell>
  );
}

function ImageGeneratorNode({
  id,
  data,
  selected,
}: NodeProps<ImageGeneratorNodeData>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const {
    getGeneratorImageInputs,
    getGeneratorIterationInfo,
    setImageGeneratorAspectRatio,
    runNode,
  } = useStudioContext();
  const imageInputs = getGeneratorImageInputs(id);
  const iterationInfo = getGeneratorIterationInfo(id);

  useEffect(() => {
    if (!imageInputs.length) {
      return;
    }

    updateNodeInternals(id);
  }, [id, imageInputs.length, updateNodeInternals]);

  return (
    <NodeShell
      data={data}
      icon="GEN"
      inputs={[
        { id: PROMPT_INPUT_HANDLE_ID, label: "Prompt", color: "#f59e0b" },
        ...imageInputs,
      ]}
      model="Gemini 3 Pro Image (Nano Banana)"
      output={{ id: "images", label: "Images", color: "#22c55e" }}
      selected={selected}
    >
      <div className="grid grid-cols-2 gap-2">
        <Card className="py-0">
          <CardContent className="space-y-2 py-3 text-sm">
            <div className="text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
            Aspect
            </div>
            <Select
              onValueChange={(value) =>
                setImageGeneratorAspectRatio(id, value as ImageAspectRatio)
              }
              value={data.aspectRatio}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
            {IMAGE_ASPECT_RATIOS.map((ratio) => (
                  <SelectItem key={ratio} value={ratio}>
                {ratio}
                  </SelectItem>
            ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <Card className="py-0">
          <CardContent className="space-y-2 py-3 text-sm">
            <div className="text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
            Model
            </div>
            <Badge variant="outline">{data.model}</Badge>
          </CardContent>
        </Card>
      </div>

      {iterationInfo.hasIterator ? (
        <Card className="border-primary/30 bg-primary/10 py-0">
          <CardContent className="py-3 text-sm">
          {iterationInfo.mismatchedIterators
            ? "Connected iterators disagree on batch size."
            : `Will run ${iterationInfo.iterations} iteration${iterationInfo.iterations === 1 ? "" : "s"}. Other connected images are reused in every pass.`}
          </CardContent>
        </Card>
      ) : null}

      <ShellButton
        className="w-full justify-center"
        onClick={() => void runNode(id)}
      >
        Run image generation
      </ShellButton>

      {data.lastPrompt ? (
        <Card className="py-0">
          <CardContent className="py-3 text-sm">
            <div className="mb-2 text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
            Last prompt
            </div>
          <p>{data.lastPrompt}</p>
          </CardContent>
        </Card>
      ) : null}

      {data.responseText ? (
        <Card className="py-0">
          <CardContent className="py-3 text-sm">
            <div className="mb-2 text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
            Model note
            </div>
          <p>{data.responseText}</p>
          </CardContent>
        </Card>
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
    getGeneratorImageInputs,
    getGeneratorIterationInfo,
    setVideoGeneratorAspectRatio,
    setVideoGeneratorDuration,
    setVideoGeneratorResolution,
    setVideoGeneratorGenerateAudio,
    runNode,
  } = useStudioContext();
  const imageInputs = getGeneratorImageInputs(id);
  const iterationInfo = getGeneratorIterationInfo(id);

  useEffect(() => {
    if (!imageInputs.length) {
      return;
    }

    updateNodeInternals(id);
  }, [id, imageInputs.length, updateNodeInternals]);

  return (
    <NodeShell
      data={data}
      icon="MOT"
      inputs={[
        { id: PROMPT_INPUT_HANDLE_ID, label: "Prompt", color: "#f59e0b" },
        ...imageInputs,
      ]}
      model="Veo 3.1"
      output={{ id: "videos", label: "Videos", color: "#a78bfa" }}
      selected={selected}
    >
      <div className="grid grid-cols-2 gap-2">
        <Card className="py-0">
          <CardContent className="space-y-2 py-3 text-sm">
            <div className="text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
            Aspect
            </div>
            <Select
              onValueChange={(value) =>
                setVideoGeneratorAspectRatio(id, value as VideoAspectRatio)
              }
              value={data.aspectRatio}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
            {VIDEO_ASPECT_RATIOS.map((ratio) => (
                  <SelectItem key={ratio} value={ratio}>
                {ratio}
                  </SelectItem>
            ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <Card className="py-0">
          <CardContent className="space-y-2 py-3 text-sm">
            <div className="text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
            Duration
            </div>
            <Select
              onValueChange={(value) =>
                setVideoGeneratorDuration(id, Number(value) as VideoDuration)
              }
              value={String(data.durationSeconds)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
            {VIDEO_DURATIONS.map((duration) => (
                  <SelectItem key={duration} value={String(duration)}>
                {duration}s
                  </SelectItem>
            ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <Card className="py-0">
          <CardContent className="space-y-2 py-3 text-sm">
            <div className="text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
            Resolution
            </div>
            <Select
              onValueChange={(value) =>
                setVideoGeneratorResolution(id, value as VideoResolution)
              }
              value={data.resolution}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
            {VIDEO_RESOLUTIONS.map((resolution) => (
                  <SelectItem key={resolution} value={resolution}>
                {resolution}
                  </SelectItem>
            ))}
              </SelectContent>
            </Select>
          </CardContent>
        </Card>
        <Card className="py-0">
          <CardContent className="flex items-center justify-between py-3 text-sm">
            <span>Generate audio</span>
            <Switch
              checked={data.generateAudio}
              onCheckedChange={(checked) =>
                setVideoGeneratorGenerateAudio(id, checked)
              }
            />
          </CardContent>
        </Card>
      </div>

      {iterationInfo.hasIterator ? (
        <Card className="border-primary/30 bg-primary/10 py-0">
          <CardContent className="py-3 text-sm">
          {iterationInfo.mismatchedIterators
            ? "Connected iterators disagree on batch size."
            : `Will run ${iterationInfo.iterations} iteration${iterationInfo.iterations === 1 ? "" : "s"}. Other connected images are reused in every pass.`}
          </CardContent>
        </Card>
      ) : null}

      <ShellButton
        className="w-full justify-center"
        onClick={() => void runNode(id)}
      >
        Run video generation
      </ShellButton>

      {data.lastPrompt ? (
        <Card className="py-0">
          <CardContent className="py-3 text-sm">
            <div className="mb-2 text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
            Last prompt
            </div>
          <p>{data.lastPrompt}</p>
          </CardContent>
        </Card>
      ) : null}

      <OutputGallery assets={data.outputAssets} />
    </NodeShell>
  );
}

export const nodeTypes = {
  prompt: PromptNode,
  image: ImageUploadNode,
  video: VideoUploadNode,
  imageIterator: ImageIteratorNode,
  imageGenerator: ImageGeneratorNode,
  videoGenerator: VideoGeneratorNode,
};
