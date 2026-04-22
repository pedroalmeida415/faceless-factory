"use client";

import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { RiCloseLine } from "@remixicon/react";
import { useEffect, useRef } from "react";

import { Badge } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "~/components/ui/drawer";
import { cn } from "~/lib/utils";
import { formatWorkflowAssetSize } from "~/lib/workflow/assets";
import type { WorkflowAsset } from "~/lib/workflow/types";
import { api } from "~/trpc/react";
import { getWorkflowAssetDragData } from "./asset-dnd";
import { AssetPreview, ShellButton } from "./shared";
import { useWorkflowStudioStore } from "./store";

function AssetLibrarySection({
  assets,
  emptyMessage,
  title,
}: {
  assets: WorkflowAsset[];
  emptyMessage: string;
  title: string;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="font-medium text-[11px] text-muted-foreground uppercase tracking-[0.24em]">
          {title}
        </div>
        <Badge className="rounded-full px-2 font-normal" variant="outline">
          {assets.length}
        </Badge>
      </div>
      {assets.length ? (
        <div className="grid auto-rows-auto grid-cols-2 gap-3">
          {assets.map((asset) => (
            <AssetLibraryCard asset={asset} key={asset.id} />
          ))}
        </div>
      ) : (
        <Card className="border-dashed py-0">
          <CardContent className="py-4 text-muted-foreground text-sm">
            {emptyMessage}
          </CardContent>
        </Card>
      )}
    </section>
  );
}

function AssetLibraryCard({ asset }: { asset: WorkflowAsset }) {
  const elementRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) {
      return;
    }

    return draggable({
      element,
      getInitialData: () => getWorkflowAssetDragData(asset),
    });
  }, [asset]);

  return (
    <div className="h-full cursor-grab active:cursor-grabbing" ref={elementRef}>
      <Card
        className="flex h-full flex-col gap-0 rounded-2xl border-border/60 bg-background/70 py-0"
        size="sm"
      >
        <div
          className={cn(
            "overflow-hidden border-border/60 border-b bg-muted/20",
            asset.kind === "video" ? "aspect-video" : "aspect-square",
          )}
        >
          <AssetPreview asset={asset} />
        </div>
        <CardContent className="space-y-3 py-3">
          <div className="space-y-1">
            <div className="truncate font-medium">{asset.fileName}</div>
            <div className="text-muted-foreground text-xs">
              {asset.size
                ? formatWorkflowAssetSize(asset.size)
                : "Size unavailable"}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge className="rounded-full px-2 font-normal" variant="outline">
              {asset.kind}
            </Badge>
            <Badge
              className="rounded-full px-2 font-normal"
              variant={asset.source === "generated" ? "default" : "secondary"}
            >
              {asset.source}
            </Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function AssetLibrary({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const utils = api.useUtils();
  const lastExecutionFinishedAt = useWorkflowStudioStore(
    (state) => state.lastExecutionFinishedAt,
  );
  const assetsQuery = api.workflow.listAssets.useQuery(
    { projectId },
    {
      staleTime: 30_000,
    },
  );
  const assets = assetsQuery.data ?? [];
  const uploadedAssets = assets.filter((asset) => asset.source === "upload");
  const generatedAssets = assets.filter(
    (asset) => asset.source === "generated",
  );

  useEffect(() => {
    if (!lastExecutionFinishedAt) {
      return;
    }

    void utils.workflow.listAssets.invalidate({ projectId });
  }, [lastExecutionFinishedAt, projectId, utils]);

  return (
    <Drawer
      direction="left"
      modal={false}
      onOpenChange={onOpenChange}
      open={open}
    >
      <DrawerContent className="h-screen rounded-none border-border/60 border-r bg-background/95 p-0 before:hidden data-[vaul-drawer-direction=left]:w-full data-[vaul-drawer-direction=left]:max-w-[380px]">
        <DrawerHeader className="border-border/60 border-b px-5 py-4 text-left">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <DrawerTitle>Assets</DrawerTitle>
              <DrawerDescription>
                Drag uploaded or generated media into the canvas.
              </DrawerDescription>
            </div>
            <DrawerClose asChild>
              <ShellButton
                aria-label="Close assets drawer"
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
          {assetsQuery.error ? (
            <Card className="border-dashed py-0">
              <CardContent className="py-4 text-destructive text-sm">
                {assetsQuery.error.message}
              </CardContent>
            </Card>
          ) : assetsQuery.isLoading ? (
            <Card className="border-dashed py-0">
              <CardContent className="py-4 text-muted-foreground text-sm">
                Loading assets...
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              <AssetLibrarySection
                assets={uploadedAssets}
                emptyMessage="No uploaded assets yet."
                title="Uploaded"
              />
              <AssetLibrarySection
                assets={generatedAssets}
                emptyMessage="No generated assets yet."
                title="Generated"
              />
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
