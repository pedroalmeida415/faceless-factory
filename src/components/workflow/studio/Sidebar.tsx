"use client";

import {
  RiFolderImageLine,
  RiImageAiLine,
  RiImageLine,
  RiRobot2Line,
  RiShuffleLine,
  RiVideoAiLine,
} from "@remixicon/react";
import { Card, CardContent } from "~/components/ui/card";
import { cn } from "~/lib/utils";
import type { WorkflowNodeKind } from "~/lib/workflow/types";
import { ShellButton } from "./shared";

const TextIcon = () => (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <title>Text</title>
    <g clipPath="url(#clip0_231_384)">
      <path
        d="M12 5.25V18.75"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      ></path>
      <path
        d="M5.25 8.25V5.25H18.75V8.25"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      ></path>
      <path
        d="M9 18.75H15"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      ></path>
    </g>
    <defs>
      <clipPath id="clip0_231_384">
        <rect width="24" height="24" fill="currentColor"></rect>
      </clipPath>
    </defs>
  </svg>
);

const NODE_ACTION_GROUPS: Array<{
  label: string;
  actions: Array<{
    kind: WorkflowNodeKind;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }>;
}> = [
  {
    label: "Inputs",
    actions: [
      { kind: "list", label: "List", icon: TextIcon },
      { kind: "prompt", label: "Prompt", icon: TextIcon },
      { kind: "asset", label: "Asset", icon: RiImageLine },
    ],
  },
  {
    label: "Transforms",
    actions: [
      { kind: "laneReorder", label: "Lane Reorder", icon: RiShuffleLine },
    ],
  },
  {
    label: "Generators",
    actions: [
      { kind: "llmGenerator", label: "Run any LLM", icon: RiRobot2Line },
      { kind: "videoGenerator", label: "Video Gen", icon: RiVideoAiLine },
      {
        kind: "imageGenerator",
        label: "Image Gen",
        icon: RiImageAiLine,
      },
    ],
  },
];

export function WorkflowSidebar({
  onAddNode,
  onToggleAssetLibrary,
  isAssetLibraryOpen,
}: {
  onAddNode: (kind: WorkflowNodeKind) => void;
  onToggleAssetLibrary: () => void;
  isAssetLibraryOpen: boolean;
}) {
  return (
    <aside className="pointer-events-none absolute top-4 left-4 z-[60]">
      <Card className="pointer-events-auto rounded-[32px] border-border/60 bg-background/88 py-2 shadow-2xl backdrop-blur-xl">
        <CardContent className="flex flex-col items-center gap-2 px-2 py-0">
          {NODE_ACTION_GROUPS.map((group, groupIndex) => (
            <div className="contents" key={group.label}>
              {groupIndex > 0 ? (
                <div className="h-px w-8 bg-border/60" />
              ) : null}
              <div className="py-1 text-[8px] text-muted-foreground uppercase tracking-[0.18em] [writing-mode:vertical-rl]">
                {group.label}
              </div>
              {group.actions.map(({ kind, label, icon: Icon }) => (
                <ShellButton
                  aria-label={label}
                  className="size-11 rounded-full border-border/60 bg-background/70 p-0"
                  key={kind}
                  onClick={() => onAddNode(kind)}
                  size="icon"
                  title={label}
                >
                  <Icon className="size-4" />
                </ShellButton>
              ))}
            </div>
          ))}
          <div className="h-px w-8 bg-border/60" />
          <ShellButton
            aria-label={
              isAssetLibraryOpen ? "Close assets drawer" : "Open assets drawer"
            }
            aria-pressed={isAssetLibraryOpen}
            className={cn(
              "size-11 rounded-full border-border/60 bg-background/70 p-0",
              isAssetLibraryOpen && "bg-primary/10 text-primary",
            )}
            onClick={onToggleAssetLibrary}
            size="icon"
            title={isAssetLibraryOpen ? "Close assets" : "Open assets"}
          >
            <RiFolderImageLine className="size-4" />
          </ShellButton>
        </CardContent>
      </Card>
    </aside>
  );
}
