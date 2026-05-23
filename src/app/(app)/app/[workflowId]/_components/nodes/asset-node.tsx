"use client";

import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { FileAudioIcon, ImageIcon, UploadIcon, VideoIcon } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { UploadFilesModal } from "~/components/modals-upload-files";
import { NodeCard, NodeCardAction, NodeCardHeader, NodeCardPanel, NodeCardTitle } from "~/components/node-card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import type { WorkflowAssetNode } from "~/features/workflow/domain/graph";
import { formatDuration, type UploadedFile } from "~/hooks/use-upload-files";
import { cn } from "~/lib/utils";
import { useWorkflowStore } from "../../_hooks/use-workflow-store";

type AssetFlowNode = Node<WorkflowAssetNode["data"], WorkflowAssetNode["type"]>;
type WorkflowAsset = WorkflowAssetNode["data"]["assets"][number];
const MAX_ASPECT_RATIO = 21 / 9;
const MIN_ASPECT_RATIO = 9 / 21;
type AssetMediaFrame = {
  readonly kind: "landscape" | "portrait" | "square";
  readonly style?: CSSProperties;
};

export function AssetNode(props: NodeProps<AssetFlowNode>) {
  const updateNodeData = useWorkflowStore((store) => store.updateNodeData);
  const [uploadOpen, setUploadOpen] = useState(false);
  const ownedPreviewUrls = useRef(new Set<string>());
  const asset = props.data.assets[0];

  useEffect(() => {
    return () => {
      for (const previewUrl of ownedPreviewUrls.current) {
        if (previewUrl.startsWith("blob:")) {
          URL.revokeObjectURL(previewUrl);
        }
      }
      ownedPreviewUrls.current.clear();
    };
  }, []);

  function handleUpload(files: readonly UploadedFile[]) {
    const file = files[0];

    if (!file) {
      return;
    }

    const previousPreviewUrl = props.data.assets[0]?.previewUrl;

    if (previousPreviewUrl && ownedPreviewUrls.current.has(previousPreviewUrl)) {
      URL.revokeObjectURL(previousPreviewUrl);
      ownedPreviewUrls.current.delete(previousPreviewUrl);
    }

    ownedPreviewUrls.current.add(file.previewUrl);

    updateNodeData<WorkflowAssetNode>(props.id, {
      assets: [
        {
          assetId: `asset-${crypto.randomUUID()}`,
          durationSeconds: nonNegativeFinite(file.metadata.durationSeconds),
          height: positiveInteger(file.metadata.height),
          mediaType: file.mediaType,
          mimeType: file.mimeType,
          name: file.name,
          previewUrl: file.previewUrl,
          sizeBytes: file.sizeBytes,
          width: positiveInteger(file.metadata.width),
        },
      ],
    });
  }

  return (
    <>
      <NodeCard className="group w-fit">
        <NodeCardHeader>
          <NodeCardTitle>Asset</NodeCardTitle>
          {asset ? (
            <NodeCardAction>
              <Button className="nodrag" onClick={() => setUploadOpen(true)} size="sm" variant="outline">
                Replace
              </Button>
            </NodeCardAction>
          ) : null}
        </NodeCardHeader>
        <NodeCardPanel className="p-0">
          {asset ? <AssetMedia asset={asset} /> : <EmptyAssetState onClick={() => setUploadOpen(true)} />}
        </NodeCardPanel>
        <Handle position={Position.Right} type="source" />
      </NodeCard>
      <UploadFilesModal
        acceptedMediaTypes={["image", "video", "audio"]}
        description="Upload one image, video, or audio file."
        multiple={false}
        onOpenChange={setUploadOpen}
        onUpload={handleUpload}
        open={uploadOpen}
        title="Add media"
      />
    </>
  );
}

function EmptyAssetState({ onClick }: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      className="flex size-90 flex-col items-center justify-center gap-2 rounded-b-2xl border border-border border-dashed bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
    >
      <UploadIcon className="size-5" />
      <span className="font-medium text-sm">Add Media</span>
    </button>
  );
}

function AssetMedia({ asset }: { readonly asset: WorkflowAsset }) {
  const frame = getAssetMediaFrame(asset);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-b-2xl bg-muted",
        frame.kind === "square" && "size-90",
        frame.kind === "landscape" && "aspect-video h-90",
        frame.kind === "portrait" && "aspect-video w-90",
      )}
      style={frame.style}
    >
      {renderMediaElement(asset)}
      <div className="absolute right-6 bottom-4 flex max-w-[70%] flex-wrap justify-end gap-1.5 opacity-0 transition-opacity duration-300 ease-in-out group-focus-within:opacity-100 group-hover:opacity-100">
        {getMetadataBadges(asset).map((badge) => (
          <Badge key={badge} className="border-border bg-popover text-primary" size="lg">
            {badge}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function renderMediaElement(asset: WorkflowAsset) {
  if (asset.mediaType === "image" && asset.previewUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: user-selected blob previews cannot be optimized by next/image.
      <img alt={asset.name ?? "Uploaded asset"} className="size-full object-contain" src={asset.previewUrl} />
    );
  }

  if (asset.mediaType === "video" && asset.previewUrl) {
    // biome-ignore lint/a11y/useMediaCaption: uploaded local media has no caption track at selection time.
    return <video className="size-full bg-muted object-contain" controls src={asset.previewUrl} />;
  }

  if (asset.mediaType === "audio" && asset.previewUrl) {
    return (
      <div className="flex size-full flex-col items-center justify-center gap-5 px-5 py-8">
        <div className="flex size-16 items-center justify-center rounded-full bg-background text-muted-foreground">
          <FileAudioIcon className="size-8" />
        </div>
        {/* biome-ignore lint/a11y/useMediaCaption: uploaded local media has no caption track at selection time. */}
        <audio className="w-full" controls src={asset.previewUrl} />
      </div>
    );
  }

  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 px-5 text-muted-foreground">
      <MediaFallbackIcon mediaType={asset.mediaType} />
      <span className="max-w-full truncate text-sm">{asset.name ?? asset.assetId}</span>
    </div>
  );
}

function MediaFallbackIcon({ mediaType }: { readonly mediaType: WorkflowAsset["mediaType"] }) {
  const className = "size-7 text-muted-foreground";

  if (mediaType === "video") {
    return <VideoIcon className={className} />;
  }

  if (mediaType === "audio") {
    return <FileAudioIcon className={className} />;
  }

  return <ImageIcon className={className} />;
}

function getMetadataBadges(asset: WorkflowAsset) {
  const badges: string[] = [];

  if (asset.width && asset.height) {
    badges.push(`${asset.width}x${asset.height}`);
  }

  if (asset.durationSeconds !== undefined) {
    badges.push(formatDuration(asset.durationSeconds));
  }

  return badges;
}

function getAssetMediaFrame(asset: WorkflowAsset): AssetMediaFrame {
  if (!asset.width || !asset.height || asset.width <= 0 || asset.height <= 0) {
    return {
      kind: "square",
    };
  }

  const aspectRatio = Math.min(Math.max(asset.width / asset.height, MIN_ASPECT_RATIO), MAX_ASPECT_RATIO);

  if (aspectRatio >= 1) {
    return {
      kind: "landscape",
      style: { aspectRatio },
    };
  }

  return {
    kind: "portrait",
    style: { aspectRatio },
  };
}

function positiveInteger(value: number | undefined) {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeFinite(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}
