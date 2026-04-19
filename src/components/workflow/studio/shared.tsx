"use client";

import Image from "next/image";
import {
  type PropsWithChildren,
  useId,
} from "react";
import { Handle, Position } from "reactflow";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import type {
  WorkflowAsset,
  WorkflowNodeData,
  WorkflowNodeStatus,
} from "~/lib/workflow/types";
import { cn } from "~/lib/utils";
import { formatNodeTitle, type HandleDefinition } from "./graph";

function statusBadgeVariant(status: WorkflowNodeStatus) {
  switch (status) {
    case "running":
      return "secondary";
    case "success":
      return "default";
    case "error":
      return "destructive";
    default:
      return "outline";
  }
}

export function ShellButton(
  props: PropsWithChildren<React.ComponentProps<typeof Button>>,
) {
  const { children, className, ...rest } = props;

  return (
    <Button className={className} type="button" variant="outline" {...rest}>
      {children}
    </Button>
  );
}

export function AssetPreview({
  asset,
  className = "",
}: {
  asset: WorkflowAsset;
  className?: string;
}) {
  if (asset.kind === "image") {
    return (
      <div className="relative h-full w-full">
        <Image
          alt={asset.fileName}
          className={cn("object-cover", className)}
          fill
          sizes="(max-width: 768px) 100vw, 320px"
          src={asset.url}
          unoptimized
        />
      </div>
    );
  }

  return (
    <video
      className={cn("h-full w-full object-cover", className)}
      controls
      preload="metadata"
      src={asset.url}
    >
      <track
        default
        kind="captions"
        label="No captions available"
        src="data:text/vtt,WEBVTT"
      />
    </video>
  );
}

export function OutputGallery({ assets }: { assets: WorkflowAsset[] }) {
  if (!assets.length) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-4 text-muted-foreground">
        No outputs yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      {assets.map((asset) => (
        <Card className="gap-0 py-0" key={asset.id}>
          <a href={asset.url} rel="noreferrer" target="_blank">
            <div className="aspect-square overflow-hidden">
            <AssetPreview asset={asset} />
            </div>
          </a>
          <CardContent className="border-t px-2 py-2 text-xs">
            <div className="truncate">{asset.fileName}</div>
            <div className="text-muted-foreground text-[10px] uppercase tracking-[0.24em]">
              {asset.source}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function FilePickerButton({
  label,
  accept,
  multiple = false,
  onFiles,
}: {
  label: string;
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
}) {
  const inputId = useId();

  return (
    <>
      <Button asChild type="button" variant="outline">
        <label className="cursor-pointer" htmlFor={inputId}>
        {label}
        </label>
      </Button>
      <input
        accept={accept}
        className="hidden"
        id={inputId}
        multiple={multiple}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) {
            onFiles(files);
          }
          event.currentTarget.value = "";
        }}
        type="file"
      />
    </>
  );
}

export function NodeShell({
  children,
  data,
  icon,
  inputs = [],
  output = null,
  model = null,
  selected = false,
}: PropsWithChildren<{
  data: WorkflowNodeData;
  icon: string;
  inputs?: HandleDefinition[];
  output?: HandleDefinition | null;
  model?: string | null;
  selected?: boolean;
}>) {
  const inputLegend = inputs.filter(
    (input, index, list) =>
      list.findIndex(
        (candidate) =>
          candidate.label === input.label && candidate.color === input.color,
      ) === index,
  );

  return (
    <Card
      className={cn(
        "relative gap-4 overflow-visible py-4",
        selected && "ring-2 ring-primary",
      )}
      size="sm"
    >
      {inputs.map((input, index) => (
        <Handle
          id={input.id}
          key={input.id}
          position={Position.Left}
          style={{
            background: input.color,
            border: "2px solid rgba(255,255,255,0.9)",
            height: 14,
            left: -8,
            top: 92 + index * 30,
            width: 14,
          }}
          type="target"
        />
      ))}
      {output ? (
        <Handle
          id={output.id}
          position={Position.Right}
          style={{
            background: output.color,
            border: "2px solid rgba(255,255,255,0.9)",
            height: 14,
            right: -8,
            top: "50%",
            transform: "translateY(-50%)",
            width: 14,
          }}
          type="source"
        />
      ) : null}

      <CardHeader className="gap-3">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground uppercase tracking-[0.28em]">
            <span>{formatNodeTitle(data.kind)}</span>
            {selected ? (
              <Badge variant="secondary">selected</Badge>
            ) : null}
            <Badge variant={statusBadgeVariant(data.status)}>
              {data.status}
            </Badge>
        </div>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <CardTitle className="text-lg leading-tight">{data.label}</CardTitle>
            {model ? <CardDescription className="text-xs">{model}</CardDescription> : null}
          </div>
          <Badge variant="outline">{icon}</Badge>
        </div>
      </CardHeader>

      {inputLegend.length ? (
        <CardContent className="space-y-2">
          {inputLegend.map((input) => (
            <div
              className="flex items-center gap-2 text-[11px] text-muted-foreground uppercase tracking-[0.22em]"
              key={input.id}
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: input.color }}
              />
              <span>{input.label}</span>
            </div>
          ))}
        </CardContent>
      ) : null}

      <CardContent className="space-y-3">{children}</CardContent>

      {data.error ? (
        <CardContent>
          <Card className="border-destructive/40 bg-destructive/10 py-3 text-destructive">
            <CardContent>{data.error}</CardContent>
          </Card>
        </CardContent>
      ) : null}
    </Card>
  );
}
