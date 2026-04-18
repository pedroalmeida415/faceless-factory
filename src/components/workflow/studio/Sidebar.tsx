"use client";

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
    <aside className="w-[320px] shrink-0 rounded-[32px] border border-white/10 bg-black/20 p-5 shadow-[0_30px_90px_rgba(0,0,0,0.35)] backdrop-blur">
      <div className="mb-8">
        <div className="mb-2 text-[11px] text-slate-400 uppercase tracking-[0.32em]">
          Faceless Factory
        </div>
        <h1 className="font-semibold text-3xl leading-tight">
          Node-based AI workflow MVP
        </h1>
        <p className="mt-3 text-slate-300 text-sm leading-6">
          Minimal Weavy-style canvas with local uploads, image iteration, Nano
          Banana Pro image generation, and Veo 3.1 video generation.
        </p>
      </div>

      <div className="mb-8 space-y-3">
        <div className="text-[11px] text-slate-400 uppercase tracking-[0.32em]">
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
      </div>

      <div className="mb-8 space-y-3">
        <div className="text-[11px] text-slate-400 uppercase tracking-[0.32em]">
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
      </div>

      <div className="space-y-3">
        <div className="text-[11px] text-slate-400 uppercase tracking-[0.32em]">
          Notes
        </div>
        <div className="rounded-[28px] border border-white/10 bg-black/20 p-4 text-slate-300 text-sm leading-6">
          <p>{activity}</p>
          <hr className="my-4 border-white/10" />
          <p>
            Image model locked to{" "}
            <span className="text-white">{NANO_BANANA_PRO_MODEL_ID}</span>.
          </p>
          <p>
            Video model locked to{" "}
            <span className="text-white">{VEO_31_MODEL_ID}</span>.
          </p>
          <p>Uploads and generated assets persist in local server storage.</p>
        </div>
      </div>
    </aside>
  );
}
