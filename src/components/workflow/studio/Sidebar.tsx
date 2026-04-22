"use client";

import { RiImageAiLine, RiImageLine, RiVideoAiLine } from "@remixicon/react";
import { Card, CardContent } from "~/components/ui/card";
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

const NODE_ACTIONS: Array<{
  kind: WorkflowNodeKind;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { kind: "prompt", label: "Text", icon: TextIcon },
  { kind: "asset", label: "Asset", icon: RiImageLine },
  { kind: "videoGenerator", label: "Video generator", icon: RiVideoAiLine },
  {
    kind: "imageGenerator",
    label: "Image Gen",
    icon: RiImageAiLine,
  },
];

export function WorkflowSidebar({
  onAddNode,
}: {
  onAddNode: (kind: WorkflowNodeKind) => void;
}) {
  return (
    <aside className="pointer-events-none absolute top-4 left-4 z-20">
      <Card className="pointer-events-auto rounded-[32px] border-border/60 bg-background/88 py-2 shadow-2xl backdrop-blur-xl">
        <CardContent className="flex flex-col items-center gap-2 px-2 py-0">
          {NODE_ACTIONS.map(({ kind, label, icon: Icon }) => (
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
        </CardContent>
      </Card>
    </aside>
  );
}
