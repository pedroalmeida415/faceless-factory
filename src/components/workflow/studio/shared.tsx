"use client";

import Image from "next/image";
import { Fragment, type PropsWithChildren, type ReactNode, useId } from "react";
import { Handle, Position } from "reactflow";

import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { cn } from "~/lib/utils";
import {
  formatWorkflowAssetSize,
  shouldInlineAssetPreview,
} from "~/lib/workflow/assets";
import type { WorkflowAsset, WorkflowNodeData } from "~/lib/workflow/types";
import type { HandleDefinition } from "./graph";
import { useWorkflowStudioStore } from "./store";

function formatHandleLabel(handle: HandleDefinition) {
  return handle.labelIndex
    ? `${handle.label} ${handle.labelIndex}`
    : handle.label;
}

const socketLabelClassName =
  "pointer-events-none absolute z-10 -translate-y-4 whitespace-nowrap text-[9px] opacity-0 transition-opacity duration-200 group-hover:opacity-100";

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
  if (!shouldInlineAssetPreview(asset)) {
    return (
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-center gap-2 bg-muted/40 p-3 text-center",
          className,
        )}
      >
        <div className="text-[10px] text-muted-foreground uppercase tracking-[0.24em]">
          {asset.kind}
        </div>
        <div className="line-clamp-2 font-medium text-xs">{asset.fileName}</div>
        <div className="text-[10px] text-muted-foreground">
          {asset.size
            ? `${formatWorkflowAssetSize(asset.size)} - open to preview`
            : "Open to preview"}
        </div>
      </div>
    );
  }

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
            <div
              className={cn(
                "overflow-hidden",
                asset.kind === "video" ? "aspect-video" : "aspect-square",
              )}
            >
              <AssetPreview asset={asset} />
            </div>
          </a>
          <CardContent className="border-t px-2 py-2 text-xs">
            <div className="truncate">{asset.fileName}</div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-[0.24em]">
              {asset.source}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function NodeFieldCard({
  children,
  label,
}: PropsWithChildren<{
  label: string;
}>) {
  return (
    <Card className="py-0">
      <CardContent className="space-y-2 py-3 text-sm">
        <div className="text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
          {label}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export function NodeNotice({
  children,
  tone = "default",
}: PropsWithChildren<{
  tone?: "default" | "accent";
}>) {
  return (
    <Card
      className={cn(
        "py-0",
        tone === "accent" && "border-primary/30 bg-primary/10",
      )}
    >
      <CardContent className="py-3 text-sm">{children}</CardContent>
    </Card>
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
  headerDetail,
  id,
  inputs = [],
  output = null,
  selected = false,
}: PropsWithChildren<{
  data: WorkflowNodeData;
  headerDetail?: ReactNode;
  id: string;
  inputs?: HandleDefinition[];
  output?: HandleDefinition | null;
  selected?: boolean;
}>) {
  const edges = useWorkflowStudioStore((state) => state.edges);
  const outputConnected = output
    ? edges.some(
        (edge) => edge.source === id && edge.sourceHandle === output.id,
      )
    : false;
  const socketTop = 64;
  const socketGap = 32;

  return (
    <Card
      className={cn(
        "group relative gap-4 overflow-visible pt-2 pb-4",
        selected && "ring-2 ring-primary",
      )}
      size="sm"
    >
      {inputs.map((input, index) => {
        const top = socketTop + index * socketGap;
        const isConnected = edges.some(
          (edge) => edge.target === id && edge.targetHandle === input.id,
        );

        return (
          <Fragment key={input.id}>
            <div
              className={cn(socketLabelClassName, "right-full pr-3")}
              style={{ color: input.color, top }}
            >
              <span>{formatHandleLabel(input)}</span>
            </div>
            <Handle
              id={input.id}
              position={Position.Left}
              style={{
                background: isConnected ? input.color : "transparent",
                border: "2px solid rgba(255,255,255,0.9)",
                boxShadow: isConnected
                  ? undefined
                  : `inset 0 0 0 2px ${input.color}`,
                height: 14,
                left: -8,
                top,
                width: 14,
              }}
              type="target"
            />
          </Fragment>
        );
      })}
      {output ? (
        <Fragment key={output.id}>
          <div
            className={cn(socketLabelClassName, "left-full pl-3")}
            style={{ color: output.color, top: socketTop }}
          >
            <span>{formatHandleLabel(output)}</span>
          </div>
          <Handle
            id={output.id}
            position={Position.Right}
            style={{
              background: outputConnected ? output.color : "transparent",
              border: "2px solid rgba(255,255,255,0.9)",
              boxShadow: outputConnected
                ? undefined
                : `inset 0 0 0 2px ${output.color}`,
              height: 14,
              right: -8,
              top: socketTop,
              width: 14,
            }}
            type="source"
          />
        </Fragment>
      ) : null}

      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <CardTitle className="text-lg leading-tight">{data.label}</CardTitle>
          {headerDetail || data.status === "running" ? (
            <div className="flex items-center gap-2">
              {headerDetail}
              {data.status === "running" ? (
                <div
                  aria-label="Running"
                  className="mt-1 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-muted border-t-foreground"
                  role="status"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </CardHeader>

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
