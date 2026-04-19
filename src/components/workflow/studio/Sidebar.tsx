"use client";

import { Badge } from "~/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Separator } from "~/components/ui/separator";
import {
  NANO_BANANA_PRO_MODEL_ID,
  VEO_31_MODEL_ID,
  type WorkflowNodeKind,
} from "~/lib/workflow/types";
import { formatNodeTitle } from "./graph";
import { ShellButton } from "./shared";

export function WorkflowSidebar({
  activity,
  onAddNode,
  onRedo,
  onReset,
  onRun,
  onUndo,
  canRedo,
  canUndo,
}: {
  activity: string;
  onAddNode: (kind: WorkflowNodeKind) => void;
  onRedo: () => void;
  onReset: () => void;
  onRun: () => void;
  onUndo: () => void;
  canRedo: boolean;
  canUndo: boolean;
}) {
  return (
    <aside className="w-[320px] shrink-0">
      <Card className="sticky top-5 gap-0">
        <CardHeader>
          <Badge className="w-fit" variant="outline">
            Faceless Factory
          </Badge>
          <CardTitle className="text-3xl leading-tight">
            Node-based AI workflow MVP
          </CardTitle>
          <CardDescription className="leading-6">
          Minimal Weavy-style canvas with local uploads, image iteration, Nano
          Banana Pro image generation, and Veo 3.1 video generation.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="text-muted-foreground text-[11px] uppercase tracking-[0.32em]">
          Add nodes
          </div>
          <div className="grid grid-cols-2 gap-2">
          {(
            [
              "prompt",
              "image",
              "video",
              "imageIterator",
              "imageGenerator",
              "videoGenerator",
            ] as WorkflowNodeKind[]
          ).map((kind) => (
            <ShellButton key={kind} onClick={() => onAddNode(kind)}>
              {formatNodeTitle(kind)}
            </ShellButton>
          ))}
          </div>
        </CardContent>

        <CardContent className="space-y-3">
          <div className="text-muted-foreground text-[11px] uppercase tracking-[0.32em]">
          Run
          </div>
          <div className="grid grid-cols-1 gap-2">
          <ShellButton className="justify-center" onClick={onRun}>
            Run selected or all generators
          </ShellButton>
          <div className="grid grid-cols-2 gap-2">
            <ShellButton disabled={!canUndo} onClick={onUndo}>
              Undo
            </ShellButton>
            <ShellButton disabled={!canRedo} onClick={onRedo}>
              Redo
            </ShellButton>
          </div>
          <ShellButton className="justify-center" onClick={onReset}>
            Reset starter graph
          </ShellButton>
          </div>
        </CardContent>

        <CardContent className="space-y-3">
          <div className="text-muted-foreground text-[11px] uppercase tracking-[0.32em]">
          Notes
          </div>
          <Card className="py-4">
            <CardContent className="space-y-4 text-sm leading-6">
          <p>{activity}</p>
              <Separator />
          <p>
            Image model locked to{" "}
                <span className="text-foreground">{NANO_BANANA_PRO_MODEL_ID}</span>.
          </p>
          <p>
            Video model locked to{" "}
                <span className="text-foreground">{VEO_31_MODEL_ID}</span>.
          </p>
          <p>Uploads and generated assets persist in local server storage.</p>
            </CardContent>
          </Card>
        </CardContent>
      </Card>
    </aside>
  );
}
