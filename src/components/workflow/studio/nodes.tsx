"use client";

import { Effect } from "effect";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { type NodeProps, useUpdateNodeInternals } from "reactflow";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Slider } from "~/components/ui/slider";
import { Switch } from "~/components/ui/switch";
import {
  WORKFLOW_ASSET_UPLOAD_ACCEPT,
  WORKFLOW_IMAGE_UPLOAD_ACCEPT,
  WORKFLOW_VIDEO_UPLOAD_ACCEPT,
} from "~/lib/workflow/assets";
import { getErrorMessage } from "~/lib/workflow/errors";
import {
  type GeneratorControlDefinition,
  getImageGeneratorControlDefinitions,
  getImageGeneratorModelOptions,
  getVideoGeneratorModelOptions,
  getVideoGeneratorModeOptions,
} from "~/lib/workflow/generator-models";
import {
  getLaneAccumulatorInputValue,
  getLaneReorderInputValue,
  getLaneTransformInputValue,
} from "~/lib/workflow/graph";
import {
  createIdentityLanePermutation,
  getLanePermutationValidationMessage,
  getLaneSelectionValidationMessage,
  getLaneSplitValidationMessage,
} from "~/lib/workflow/lanes";
import {
  getLaneSplitOutputHandleId,
  LANE_ACCUMULATOR_INPUT_HANDLE_ID,
  LANE_ACCUMULATOR_OUTPUT_HANDLE_ID,
} from "~/lib/workflow/node-definitions";
import { WorkflowClientService } from "~/lib/workflow/services/workflow-client";
import type {
  AssetNodeData,
  GeneratorConfigValue,
  ImageGeneratorNodeData,
  LaneAccumulatorNodeData,
  LaneMergeNodeData,
  LaneReorderNodeData,
  LaneSelectNodeData,
  LaneSplitNodeData,
  LaneZipAlignNodeData,
  ListNodeData,
  LlmGeneratorNodeData,
  PromptNodeData,
  VideoGeneratorNodeData,
  WorkflowNodeData,
  WorkflowReviewState,
} from "~/lib/workflow/types";
import { useStudioContext } from "./context";
import { PromptEditor } from "./prompt-editor";
import {
  FilePickerButton,
  NodeFieldCard,
  NodeNotice,
  NodeShell,
  OutputGallery,
  ShellButton,
} from "./shared";
import { useWorkflowStudioStore } from "./store";
import { useWorkflowExecutionQuote } from "./useWorkflowExecutionQuote";

function capitalize(value: string) {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function getLaneValueTypeColor(valueType: "text" | "image" | "video" | null) {
  switch (valueType) {
    case "text":
      return "#f59e0b";
    case "image":
      return "#22c55e";
    case "video":
      return "#a78bfa";
    default:
      return "#94a3b8";
  }
}

function parseLaneOrder(value: string) {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const laneNumber = Number(entry);
      return Number.isInteger(laneNumber) ? [laneNumber - 1] : [];
    });
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

function formatCredits(value: number) {
  return `${value} credit${value === 1 ? "" : "s"}`;
}

function formatNumericValue(value: number, step?: number) {
  if (step && step < 1) {
    const precision = String(step).split(".")[1]?.length ?? 1;
    return value.toFixed(precision);
  }

  return String(value);
}

function updateListItem(items: string[], index: number, value: string) {
  return items.map((item, itemIndex) => (itemIndex === index ? value : item));
}

function normalizeListItems(items: string[]) {
  return items.length ? items : [""];
}

function areSameListItems(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function insertListItem(items: string[], index = items.length) {
  return [...items.slice(0, index), "", ...items.slice(index)];
}

function removeListItem(items: string[], index: number) {
  const nextItems = items.filter((_, itemIndex) => itemIndex !== index);
  return nextItems.length ? nextItems : [""];
}

export function ListItemsEditor({
  items,
  onItemsChange,
  nodeId,
}: {
  items: string[];
  onItemsChange: (items: string[]) => void;
  nodeId: string;
}) {
  const propItems = normalizeListItems(items);
  const [draftItems, setDraftItems] = useState(propItems);
  const editableItems = normalizeListItems(draftItems);
  const commitFrameRef = useRef<number | null>(null);
  const commitTimerRef = useRef<number | null>(null);
  const draftItemsRef = useRef(editableItems);
  const focusedWithinRef = useRef(false);
  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const lastPropItemsRef = useRef(propItems);
  const nextRowKey = useRef(0);
  const pendingFocusTarget = useRef<{ index: number; key: string } | null>(
    null,
  );
  const pendingItemsRef = useRef<string[] | null>(null);
  // Stale React Flow/store updates can arrive before the committed draft echoes back.
  const pendingPropItemsRef = useRef<string[] | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rowKeys = useRef<string[]>([]);
  const onItemsChangeRef = useRef(onItemsChange);

  onItemsChangeRef.current = onItemsChange;

  const clearScheduledCommit = useCallback(() => {
    if (commitFrameRef.current !== null) {
      window.cancelAnimationFrame(commitFrameRef.current);
      commitFrameRef.current = null;
    }

    if (commitTimerRef.current !== null) {
      window.clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
    }
  }, []);

  const flushItemsChange = useCallback(() => {
    const pendingItems = pendingItemsRef.current;
    if (!pendingItems) {
      return;
    }

    pendingItemsRef.current = null;
    clearScheduledCommit();

    if (areSameListItems(pendingItems, lastPropItemsRef.current)) {
      pendingPropItemsRef.current = null;
      return;
    }

    pendingPropItemsRef.current = pendingItems;
    onItemsChangeRef.current(pendingItems);
  }, [clearScheduledCommit]);

  const scheduleItemsCommit = useCallback(() => {
    clearScheduledCommit();
    commitFrameRef.current = window.requestAnimationFrame(() => {
      commitFrameRef.current = null;
      commitTimerRef.current = window.setTimeout(() => {
        commitTimerRef.current = null;
        flushItemsChange();
      }, 0);
    });
  }, [clearScheduledCommit, flushItemsChange]);

  const updateDraftItems = useCallback(
    (nextItems: string[]) => {
      const previousItems = draftItemsRef.current;
      const normalizedItems = normalizeListItems(nextItems);

      draftItemsRef.current = normalizedItems;
      setDraftItems(normalizedItems);

      if (areSameListItems(normalizedItems, lastPropItemsRef.current)) {
        pendingItemsRef.current = null;
        pendingPropItemsRef.current = null;
        clearScheduledCommit();
        return;
      }

      pendingItemsRef.current = normalizedItems;
      pendingPropItemsRef.current = normalizedItems;

      if (
        !focusedWithinRef.current ||
        previousItems.length !== normalizedItems.length
      ) {
        scheduleItemsCommit();
      }
    },
    [clearScheduledCommit, scheduleItemsCommit],
  );

  const createRowKey = () => `${nodeId}:${nextRowKey.current++}`;
  const getRowKey = (index: number) => {
    const rowKey = rowKeys.current[index] ?? createRowKey();
    rowKeys.current[index] = rowKey;
    return rowKey;
  };

  if (rowKeys.current.length < editableItems.length) {
    rowKeys.current.push(
      ...Array.from(
        { length: editableItems.length - rowKeys.current.length },
        createRowKey,
      ),
    );
  } else if (rowKeys.current.length > editableItems.length) {
    rowKeys.current = rowKeys.current.slice(0, editableItems.length);
  }

  useEffect(() => {
    if (areSameListItems(propItems, lastPropItemsRef.current)) {
      return;
    }

    lastPropItemsRef.current = propItems;

    const pendingItems = pendingItemsRef.current;
    const pendingPropItems = pendingPropItemsRef.current;

    if (pendingItems && areSameListItems(propItems, pendingItems)) {
      pendingItemsRef.current = null;
      pendingPropItemsRef.current = null;
      clearScheduledCommit();
      return;
    }

    if (pendingPropItems && areSameListItems(propItems, pendingPropItems)) {
      pendingPropItemsRef.current = null;
      return;
    }

    if (pendingItems || pendingPropItems) {
      return;
    }

    draftItemsRef.current = propItems;
    setDraftItems(propItems);
  }, [clearScheduledCommit, propItems]);

  useEffect(() => () => flushItemsChange(), [flushItemsChange]);

  useEffect(() => {
    const target = pendingFocusTarget.current;
    if (!target) {
      return;
    }

    const focusTarget = () => {
      const input =
        inputRefs.current.get(target.key) ??
        rootRef.current?.querySelector<HTMLInputElement>(
          `[data-list-input-index="${target.index}"]`,
        );

      input?.focus({ preventScroll: true });
      pendingFocusTarget.current = null;
    };

    const timeoutId = window.setTimeout(focusTarget, 0);
    const frameId = window.requestAnimationFrame(focusTarget);

    return () => {
      window.clearTimeout(timeoutId);
      window.cancelAnimationFrame(frameId);
    };
  });

  const insertAndFocus = (index: number) => {
    const rowKey = createRowKey();
    rowKeys.current.splice(index, 0, rowKey);
    pendingFocusTarget.current = { index, key: rowKey };
    updateDraftItems(insertListItem(draftItemsRef.current, index));
  };

  const removeItem = (index: number) => {
    inputRefs.current.delete(rowKeys.current[index] ?? "");
    rowKeys.current.splice(index, 1);
    updateDraftItems(removeListItem(draftItemsRef.current, index));
  };

  return (
    <div
      className="nodrag nopan nowheel space-y-3"
      onBlurCapture={(event) => {
        scheduleItemsCommit();

        const nextTarget = event.relatedTarget;
        if (
          !(nextTarget instanceof globalThis.Node) ||
          !rootRef.current?.contains(nextTarget)
        ) {
          focusedWithinRef.current = false;
        }
      }}
      onFocusCapture={() => {
        focusedWithinRef.current = true;
      }}
      ref={rootRef}
    >
      <NodeFieldCard label="Items">
        <div className="space-y-2">
          {editableItems.map((item, index) => {
            const rowKey = getRowKey(index);

            return (
              <div className="flex gap-2" key={rowKey}>
                <Input
                  nativeInput
                  className="nodrag nopan nowheel"
                  data-list-input-key={rowKey}
                  data-list-input-index={index}
                  data-list-node-id={nodeId}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) =>
                    updateDraftItems(
                      updateListItem(
                        draftItemsRef.current,
                        index,
                        event.target.value,
                      ),
                    )
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                      insertAndFocus(index + 1);
                    }
                  }}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  placeholder={`Item ${index + 1}`}
                  ref={(input) => {
                    if (input) {
                      inputRefs.current.set(rowKey, input);
                    } else {
                      inputRefs.current.delete(rowKey);
                    }
                  }}
                  value={item}
                />
                {editableItems.length > 1 ? (
                  <ShellButton
                    aria-label={`Remove item ${index + 1}`}
                    className="shrink-0"
                    onClick={() => removeItem(index)}
                  >
                    Remove
                  </ShellButton>
                ) : null}
              </div>
            );
          })}
        </div>
      </NodeFieldCard>
      <ShellButton onClick={() => insertAndFocus(editableItems.length)}>
        Add another item
      </ShellButton>
    </div>
  );
}

function isSameNodeRender<T extends WorkflowNodeData>(
  previousProps: NodeProps<T>,
  nextProps: NodeProps<T>,
) {
  return (
    previousProps.id === nextProps.id &&
    previousProps.selected === nextProps.selected &&
    previousProps.data === nextProps.data
  );
}

function WorkflowExecutionCostBadge({ nodeId }: { nodeId: string }) {
  const { priceQuote } = useWorkflowExecutionQuote(nodeId);

  if (!priceQuote || priceQuote.totalCost <= 0) {
    return null;
  }

  return (
    <Badge
      className="border-primary/20 bg-primary/10 text-primary"
      title={
        priceQuote.lineItems.length > 1
          ? priceQuote.hasEstimate
            ? "Estimate includes upstream generator costs."
            : "Includes upstream generator costs."
          : priceQuote.hasEstimate
            ? "Estimated cost. Final usage may settle higher or lower."
            : undefined
      }
      variant="outline"
    >
      {`${priceQuote.hasEstimate ? "~" : ""}${formatCredits(priceQuote.totalCost)} / run`}
    </Badge>
  );
}

function GeneratedTextPreview({ text }: { text: string | null }) {
  return text ? (
    <NodeFieldCard label="Response">
      <div className="max-h-32 overflow-hidden whitespace-pre-wrap text-sm">
        {text}
      </div>
    </NodeFieldCard>
  ) : (
    <Card className="border-dashed py-0">
      <CardContent className="py-4 text-muted-foreground text-sm">
        No response yet.
      </CardContent>
    </Card>
  );
}

export function WorkflowExecutionEstimateWarning({
  nodeId,
}: {
  nodeId: string;
}) {
  const { priceQuote } = useWorkflowExecutionQuote(nodeId);

  return (
    <NodeNotice tone="accent">
      {priceQuote
        ? `${formatCredits(priceQuote.totalCost)} estimated. Final cost varies with generated output and reasoning tokens.`
        : "Estimate only. Final cost varies with generated output and reasoning tokens."}
    </NodeNotice>
  );
}

const PromptNode = memo(function PromptNode({
  id,
  data,
  selected,
}: NodeProps<PromptNodeData>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const { addPromptVariable, setPrompt, setPromptDisplayMode } =
    useStudioContext();
  const inputHandleSignature = data.inputs.map((handle) => handle.id).join("|");

  useEffect(() => {
    inputHandleSignature;
    updateNodeInternals(id);
  }, [id, inputHandleSignature, updateNodeInternals]);

  return (
    <NodeShell
      data={data}
      id={id}
      inputs={data.inputs}
      output={{ id: "text", label: "Text", color: "#f59e0b" }}
      selected={selected}
    >
      <PromptEditor
        displayMode={data.displayMode}
        onAddVariable={() => addPromptVariable(id)}
        onChange={(prompt) => setPrompt(id, prompt)}
        onDisplayModeChange={(nextDisplayMode) =>
          setPromptDisplayMode(id, nextDisplayMode)
        }
        placeholder="Describe the shot, mood, framing, lens, motion."
        value={data.prompt}
        variables={data.variables}
      />
    </NodeShell>
  );
}, isSameNodeRender);

const ListNode = memo(function ListNode({
  id,
  data,
  selected,
}: NodeProps<ListNodeData>) {
  const { setListItems } = useStudioContext();
  const items = data.items.length ? data.items : [""];
  const filledItemCount = items.filter((item) => item.trim()).length;

  return (
    <NodeShell
      data={data}
      headerDetail={
        filledItemCount > 1 ? (
          <Badge
            className="border-primary/20 bg-primary/10 text-primary"
            variant="outline"
          >
            Lanes
          </Badge>
        ) : null
      }
      id={id}
      output={{ id: "text", label: "Text", color: "#f59e0b" }}
      selected={selected}
    >
      <ListItemsEditor
        items={items}
        nodeId={id}
        onItemsChange={(nextItems) => setListItems(id, nextItems)}
      />
      {filledItemCount > 1 ? (
        <NodeNotice tone="accent">{`${filledItemCount} lanes.`}</NodeNotice>
      ) : null}
    </NodeShell>
  );
}, isSameNodeRender);

const AssetNode = memo(function AssetNode({
  id,
  data,
  selected,
}: NodeProps<AssetNodeData>) {
  const { uploadFilesToNode, clearNodeAssets } = useStudioContext();
  const assetKindLabel = data.assetKind ? capitalize(data.assetKind) : "Asset";
  const outputColor =
    data.assetKind === "image"
      ? "#38bdf8"
      : data.assetKind === "video"
        ? "#818cf8"
        : "#94a3b8";
  const accept =
    data.assetKind === "image"
      ? WORKFLOW_IMAGE_UPLOAD_ACCEPT
      : data.assetKind === "video"
        ? WORKFLOW_VIDEO_UPLOAD_ACCEPT
        : WORKFLOW_ASSET_UPLOAD_ACCEPT;
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
            Each selected asset becomes an isolated execution lane.
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
}, isSameNodeRender);

const LaneReorderNode = memo(function LaneReorderNode({
  id,
  data,
  selected,
}: NodeProps<LaneReorderNodeData>) {
  const { setLaneReorderMode, setLaneReorderOrder, setLaneReorderShift } =
    useStudioContext();
  const document = useWorkflowStudioStore((state) => state.document);
  const inputValue = getLaneReorderInputValue(document, id);
  const laneCount =
    inputValue?.type === data.valueType ? inputValue.lanes.length : null;
  const valueTypeLabel = data.valueType ? capitalize(data.valueType) : "Lane";
  const color = getLaneValueTypeColor(data.valueType);
  const orderText = data.order.map((index) => index + 1).join(", ");
  const [orderDraft, setOrderDraft] = useState(orderText);
  const orderLabel =
    data.mode === "manual" && data.order.length
      ? data.order.map((index) => index + 1).join(" -> ")
      : `Shift ${data.shift > 0 ? "+" : ""}${data.shift}`;
  const orderValidationMessage =
    data.mode === "manual" && laneCount !== null
      ? getLanePermutationValidationMessage(data.order, laneCount)
      : null;
  const commitOrder = () => setLaneReorderOrder(id, parseLaneOrder(orderDraft));

  useEffect(() => {
    setOrderDraft(orderText);
  }, [orderText]);

  return (
    <NodeShell
      data={data}
      id={id}
      inputs={[
        {
          id: "input",
          label: valueTypeLabel,
          color,
        },
      ]}
      output={
        data.valueType ? { id: "output", label: valueTypeLabel, color } : null
      }
      selected={selected}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          className="border-border/70 bg-muted/50 text-foreground"
          variant="outline"
        >
          {data.valueType ? `${valueTypeLabel} lanes` : "Connect lanes"}
        </Badge>
        <Badge
          className="border-primary/20 bg-primary/10 text-primary"
          variant="outline"
        >
          {data.mode === "manual" ? "Manual" : "Rotate"}
        </Badge>
      </div>
      {data.valueType ? (
        <NodeNotice tone="accent">{orderLabel}</NodeNotice>
      ) : (
        <Card className="border-dashed py-0">
          <CardContent className="py-4 text-muted-foreground text-sm">
            Connect text, image, or video lanes to infer this transform type.
          </CardContent>
        </Card>
      )}

      <NodeFieldCard label="Mode">
        <Select
          onValueChange={(value) =>
            setLaneReorderMode(id, value === "manual" ? "manual" : "shift")
          }
          value={data.mode}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="shift">Shift / rotate</SelectItem>
            <SelectItem value="manual">Manual permutation</SelectItem>
          </SelectContent>
        </Select>
      </NodeFieldCard>

      {data.mode === "shift" ? (
        <NodeFieldCard label="Shift">
          <div className="grid grid-cols-3 gap-2">
            <ShellButton
              onClick={() => setLaneReorderShift(id, data.shift + 1)}
            >
              Left
            </ShellButton>
            <ShellButton
              onClick={() => setLaneReorderShift(id, data.shift - 1)}
            >
              Right
            </ShellButton>
            <ShellButton onClick={() => setLaneReorderShift(id, 0)}>
              Reset
            </ShellButton>
          </div>
        </NodeFieldCard>
      ) : (
        <NodeFieldCard label="Manual order">
          <Input
            nativeInput
            className="nodrag nopan nowheel"
            onBlur={commitOrder}
            onChange={(event) => setOrderDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            placeholder="Example: 2, 3, 1"
            value={orderDraft}
          />
          {laneCount !== null ? (
            <div className="flex items-center justify-between gap-2">
              <p className="text-muted-foreground text-xs">
                {laneCount} lane{laneCount === 1 ? "" : "s"}
              </p>
              <ShellButton
                onClick={() =>
                  setLaneReorderOrder(
                    id,
                    createIdentityLanePermutation(laneCount),
                  )
                }
              >
                Current order
              </ShellButton>
            </div>
          ) : null}
          {orderValidationMessage ? (
            <p className="text-destructive text-xs">{orderValidationMessage}</p>
          ) : null}
        </NodeFieldCard>
      )}
    </NodeShell>
  );
}, isSameNodeRender);

const LaneSelectNode = memo(function LaneSelectNode({
  id,
  data,
  selected,
}: NodeProps<LaneSelectNodeData>) {
  const { setLaneSelectIndices } = useStudioContext();
  const document = useWorkflowStudioStore((state) => state.document);
  const inputValue = getLaneTransformInputValue(document, id);
  const laneCount =
    inputValue?.type === data.valueType ? inputValue.lanes.length : null;
  const valueTypeLabel = data.valueType ? capitalize(data.valueType) : "Lane";
  const color = getLaneValueTypeColor(data.valueType);
  const orderText = data.indices.map((index) => index + 1).join(", ");
  const [draft, setDraft] = useState(orderText);
  const message =
    data.valueType && laneCount !== null
      ? getLaneSelectionValidationMessage(data.indices, laneCount)
      : null;

  useEffect(() => setDraft(orderText), [orderText]);

  return (
    <NodeShell
      data={data}
      id={id}
      inputs={[{ id: "input", label: valueTypeLabel, color }]}
      output={
        data.valueType ? { id: "output", label: valueTypeLabel, color } : null
      }
      selected={selected}
    >
      <NodeNotice tone="accent">
        {data.valueType ? `Select ${orderText || "no"} lanes` : "Connect lanes"}
      </NodeNotice>
      <NodeFieldCard label="Selected lanes">
        <Input
          nativeInput
          className="nodrag nopan nowheel"
          onBlur={() => setLaneSelectIndices(id, parseLaneOrder(draft))}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Example: 1, 3"
          value={draft}
        />
        {laneCount !== null ? (
          <p className="text-muted-foreground text-xs">
            {laneCount} upstream lanes
          </p>
        ) : null}
        {message ? <p className="text-destructive text-xs">{message}</p> : null}
      </NodeFieldCard>
    </NodeShell>
  );
}, isSameNodeRender);

const LaneSplitNode = memo(function LaneSplitNode({
  id,
  data,
  selected,
}: NodeProps<LaneSplitNodeData>) {
  const { setLaneSplitCount } = useStudioContext();
  const document = useWorkflowStudioStore((state) => state.document);
  const inputValue = getLaneTransformInputValue(document, id);
  const laneCount =
    inputValue?.type === data.valueType ? inputValue.lanes.length : null;
  const outputCount = data.valueType
    ? Math.min(data.splitCount, laneCount ?? data.splitCount)
    : 0;
  const message =
    laneCount === null
      ? null
      : getLaneSplitValidationMessage(data.splitCount, laneCount);
  const color = getLaneValueTypeColor(data.valueType);
  const valueTypeLabel = data.valueType ? capitalize(data.valueType) : "Lane";

  return (
    <NodeShell
      data={data}
      id={id}
      inputs={[{ id: "input", label: valueTypeLabel, color }]}
      outputs={
        data.valueType
          ? Array.from({ length: outputCount }, (_, index) => ({
              id: getLaneSplitOutputHandleId(index),
              label: `Lane ${index + 1}`,
              color,
            }))
          : []
      }
      selected={selected}
    >
      <NodeNotice tone="accent">
        {data.valueType ? `${outputCount} outputs` : "Connect lanes"}
      </NodeNotice>
      <NodeFieldCard label="Output count">
        <Input
          nativeInput
          max={laneCount ?? undefined}
          min={1}
          onChange={(event) =>
            setLaneSplitCount(id, Number(event.target.value))
          }
          type="number"
          value={data.splitCount}
        />
        {laneCount !== null ? (
          <p className="text-muted-foreground text-xs">
            {laneCount} upstream lanes
          </p>
        ) : null}
        {message ? <p className="text-destructive text-xs">{message}</p> : null}
      </NodeFieldCard>
    </NodeShell>
  );
}, isSameNodeRender);

const LaneMergeNode = memo(function LaneMergeNode({
  id,
  data,
  selected,
}: NodeProps<LaneMergeNodeData>) {
  const color = getLaneValueTypeColor(data.valueType);
  const valueTypeLabel = data.valueType ? capitalize(data.valueType) : "Lane";

  return (
    <NodeShell
      data={data}
      id={id}
      inputs={[{ id: "input", label: valueTypeLabel, color }]}
      output={
        data.valueType ? { id: "output", label: valueTypeLabel, color } : null
      }
      selected={selected}
    >
      <NodeNotice tone="accent">
        {data.valueType
          ? "Concatenate compatible lane streams"
          : "Connect lanes"}
      </NodeNotice>
    </NodeShell>
  );
}, isSameNodeRender);

const LaneZipAlignNode = memo(function LaneZipAlignNode({
  id,
  data,
  selected,
}: NodeProps<LaneZipAlignNodeData>) {
  const { setLaneZipAlignMode } = useStudioContext();
  const color = getLaneValueTypeColor(data.valueType);
  const valueTypeLabel = data.valueType ? capitalize(data.valueType) : "Lane";

  return (
    <NodeShell
      data={data}
      id={id}
      inputs={[{ id: "input", label: valueTypeLabel, color }]}
      output={
        data.valueType ? { id: "output", label: valueTypeLabel, color } : null
      }
      selected={selected}
    >
      <NodeNotice tone="accent">
        {data.valueType ? "Zip with existing broadcast rules" : "Connect lanes"}
      </NodeNotice>
      <NodeFieldCard label="Alignment">
        <Select
          onValueChange={(value) =>
            setLaneZipAlignMode(id, value === "broadcast" ? "broadcast" : "zip")
          }
          value={data.mode}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zip">Zip / broadcast</SelectItem>
            <SelectItem value="broadcast">Broadcast explicit</SelectItem>
          </SelectContent>
        </Select>
      </NodeFieldCard>
    </NodeShell>
  );
}, isSameNodeRender);

const LaneAccumulatorNode = memo(function LaneAccumulatorNode({
  id,
  data,
  selected,
}: NodeProps<LaneAccumulatorNodeData>) {
  const document = useWorkflowStudioStore((state) => state.document);
  const inputValue = getLaneAccumulatorInputValue(document, id);
  const laneCount =
    inputValue?.type === data.valueType ? inputValue.lanes.length : null;
  const color = getLaneValueTypeColor(data.valueType);
  const valueTypeLabel = data.valueType ? capitalize(data.valueType) : "Lane";

  return (
    <NodeShell
      data={data}
      id={id}
      inputs={[
        { id: LANE_ACCUMULATOR_INPUT_HANDLE_ID, label: valueTypeLabel, color },
      ]}
      output={
        data.valueType
          ? {
              id: LANE_ACCUMULATOR_OUTPUT_HANDLE_ID,
              label: valueTypeLabel,
              color,
            }
          : null
      }
      selected={selected}
    >
      <NodeNotice tone="accent">
        {data.valueType
          ? `Waits for all ${laneCount ?? "upstream"} lanes before continuing.`
          : "Connect lanes to create an explicit batch barrier."}
      </NodeNotice>
    </NodeShell>
  );
}, isSameNodeRender);

function GeneratorReviewPanel({
  nodeId,
  review,
  reviewEnabled,
  valueType,
}: {
  nodeId: string;
  review: WorkflowReviewState;
  reviewEnabled: boolean;
  valueType: "text" | "image" | "video";
}) {
  const document = useWorkflowStudioStore((state) => state.document);
  const activeRunId = useWorkflowStudioStore((state) => state.activeRunId);
  const applyServerExecutionState = useWorkflowStudioStore(
    (state) => state.applyServerExecutionState,
  );
  const setActivity = useWorkflowStudioStore((state) => state.setActivity);
  const node = document.nodes.find((candidate) => candidate.id === nodeId);
  const outputLaneCount =
    node && (node.kind === "imageGenerator" || node.kind === "videoGenerator")
      ? node.outputLanes.length
      : node?.kind === "llmGenerator"
        ? node.outputLanes.length
        : null;
  const laneCount =
    outputLaneCount && outputLaneCount > 0 ? outputLaneCount : null;
  const reviewLanes = review.lanes;

  const decideLane = useCallback(
    (laneIndex: number, decision: "approve" | "reject") => {
      if (!activeRunId) {
        setActivity("Run the workflow before reviewing lanes.");
        return;
      }

      const effect =
        decision === "approve"
          ? WorkflowClientService.approveReviewLane({
              laneIndex,
              reviewNodeId: nodeId,
              runId: activeRunId,
            })
          : WorkflowClientService.rejectReviewLane({
              laneIndex,
              reviewNodeId: nodeId,
              runId: activeRunId,
            });

      void Effect.runPromise(effect)
        .then((executionState) => {
          applyServerExecutionState(executionState);
        })
        .catch((error) => {
          setActivity(getErrorMessage(error));
        });
    },
    [activeRunId, applyServerExecutionState, nodeId, setActivity],
  );

  if (!reviewEnabled) {
    return null;
  }

  return (
    <>
      <NodeNotice tone="accent">
        Review is enabled. Approved lanes continue downstream; regenerated lanes
        replace this generator output.
      </NodeNotice>

      {laneCount !== null && !reviewLanes.length ? (
        <NodeNotice>{`${laneCount} lanes will be reviewed when execution reaches this node.`}</NodeNotice>
      ) : null}

      {reviewLanes.map((lane) => (
        <NodeFieldCard
          key={lane.laneIndex}
          label={`Lane ${lane.laneIndex + 1}`}
        >
          <div className="flex items-center justify-between gap-2">
            <Badge variant="outline">{lane.status}</Badge>
            <span className="text-muted-foreground text-xs">
              Attempt {lane.attempt + 1}
            </span>
          </div>
          {valueType === "text" ? (
            <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-sm">
              {lane.text || "No text output."}
            </p>
          ) : (
            <OutputGallery assets={lane.assets} />
          )}
          <div className="grid grid-cols-2 gap-2">
            <ShellButton
              className="justify-center"
              disabled={
                lane.status === "approved" || lane.status === "regenerating"
              }
              onClick={() => decideLane(lane.laneIndex, "approve")}
            >
              Approve
            </ShellButton>
            <ShellButton
              className="justify-center"
              disabled={lane.status !== "pending"}
              onClick={() => decideLane(lane.laneIndex, "reject")}
            >
              Regenerate
            </ShellButton>
          </div>
        </NodeFieldCard>
      ))}
    </>
  );
}

export function GeneratorControlGrid({
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

        if (control.type === "range") {
          const currentValue = config[control.key];
          const value =
            typeof currentValue === "number" ? currentValue : control.min;

          return (
            <NodeFieldCard key={control.key} label={control.label}>
              <div className="space-y-2">
                <div className="text-sm">
                  {formatNumericValue(value, control.step)}
                </div>
                <Slider
                  max={control.max}
                  min={control.min}
                  onValueChange={(values) =>
                    onConfigChange(control.key, values[0] ?? control.min)
                  }
                  step={control.step}
                  value={[value]}
                />
              </div>
            </NodeFieldCard>
          );
        }

        if (control.type === "number") {
          const currentValue = config[control.key];
          const value =
            typeof currentValue === "number"
              ? currentValue
              : (control.min ?? 0);

          return (
            <NodeFieldCard key={control.key} label={control.label}>
              <Input
                nativeInput
                max={control.max}
                min={control.min}
                onChange={(event) => {
                  const nextValue = Number(event.target.value);
                  if (Number.isFinite(nextValue)) {
                    onConfigChange(control.key, nextValue);
                  }
                }}
                step={control.step}
                type="number"
                value={value}
              />
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

const ImageGeneratorNode = memo(function ImageGeneratorNode({
  id,
  data,
  selected,
}: NodeProps<ImageGeneratorNodeData>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const { getGeneratorInputs, getGeneratorIterationInfo, runNode } =
    useStudioContext();
  const inputs = getGeneratorInputs(id);
  const inputHandleSignature = inputs.map((handle) => handle.id).join("|");
  const iterationInfo = getGeneratorIterationInfo(id);
  const modelOptions = getImageGeneratorModelOptions();
  const controls = getImageGeneratorControlDefinitions(data.model, data.mode);
  const modelLabel =
    modelOptions.find((option) => option.value === data.model)?.label ??
    data.model;
  const aspectRatioControl = controls.find(
    (
      control,
    ): control is Extract<GeneratorControlDefinition, { type: "select" }> =>
      control.type === "select" && control.key === "aspectRatio",
  );
  const aspectRatio =
    typeof data.config.aspectRatio === "string"
      ? data.config.aspectRatio
      : (aspectRatioControl?.options[0]?.value ?? "1:1");

  useEffect(() => {
    inputHandleSignature;
    updateNodeInternals(id);
  }, [id, inputHandleSignature, updateNodeInternals]);

  return (
    <NodeShell
      data={{ ...data, label: "Image Gen" }}
      headerDetail={<WorkflowExecutionCostBadge nodeId={id} />}
      id={id}
      inputs={inputs}
      output={{ id: "images", label: "Images", color: "#22c55e" }}
      selected={selected}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          className="border-border/70 bg-muted/50 text-foreground"
          variant="outline"
        >
          {modelLabel}
        </Badge>
        <Badge
          className="border-border/70 bg-muted/50 text-foreground"
          variant="outline"
        >
          {`Aspect ${aspectRatio}`}
        </Badge>
      </div>

      {iterationInfo.hasIterator ? (
        <NodeNotice tone="accent">
          {iterationInfo.mismatchedIterators
            ? "Connected lane counts do not match. Use one lane for broadcast or matching lane counts for zip."
            : `Will run ${iterationInfo.iterations} lane${iterationInfo.iterations === 1 ? "" : "s"}.`}
        </NodeNotice>
      ) : null}

      <OutputGallery assets={data.outputLanes.flat()} />

      <GeneratorReviewPanel
        nodeId={id}
        review={data.review}
        reviewEnabled={data.reviewEnabled}
        valueType="image"
      />

      <ShellButton
        className="w-full justify-center"
        onClick={() => void runNode(id)}
      >
        Run image generation
      </ShellButton>
    </NodeShell>
  );
}, isSameNodeRender);

const VideoGeneratorNode = memo(function VideoGeneratorNode({
  id,
  data,
  selected,
}: NodeProps<VideoGeneratorNodeData>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const { getGeneratorInputs, getGeneratorIterationInfo, runNode } =
    useStudioContext();
  const inputs = getGeneratorInputs(id);
  const inputHandleSignature = inputs.map((handle) => handle.id).join("|");
  const iterationInfo = getGeneratorIterationInfo(id);
  const modelOptions = getVideoGeneratorModelOptions();
  const modeOptions = getVideoGeneratorModeOptions(data.model);
  const modelLabel =
    modelOptions.find((option) => option.value === data.model)?.label ??
    data.model;
  const modeLabel =
    modeOptions.find((option) => option.value === data.mode)?.label ??
    data.mode;

  useEffect(() => {
    inputHandleSignature;
    updateNodeInternals(id);
  }, [id, inputHandleSignature, updateNodeInternals]);

  return (
    <NodeShell
      data={{ ...data, label: "Video Gen" }}
      headerDetail={<WorkflowExecutionCostBadge nodeId={id} />}
      id={id}
      inputs={inputs}
      output={{ id: "videos", label: "Videos", color: "#a78bfa" }}
      selected={selected}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          className="border-border/70 bg-muted/50 text-foreground"
          variant="outline"
        >
          {modelLabel}
        </Badge>
        {modeLabel ? (
          <Badge
            className="border-border/70 bg-muted/50 text-foreground"
            variant="outline"
          >
            {modeLabel}
          </Badge>
        ) : null}
      </div>

      {iterationInfo.hasIterator ? (
        <NodeNotice tone="accent">
          {iterationInfo.mismatchedIterators
            ? "Connected lane counts do not match. Use one lane for broadcast or matching lane counts for zip."
            : `Will run ${iterationInfo.iterations} lane${iterationInfo.iterations === 1 ? "" : "s"}.`}
        </NodeNotice>
      ) : null}

      <OutputGallery assets={data.outputLanes.flat()} />

      <GeneratorReviewPanel
        nodeId={id}
        review={data.review}
        reviewEnabled={data.reviewEnabled}
        valueType="video"
      />

      <ShellButton
        className="w-full justify-center"
        onClick={() => void runNode(id)}
      >
        Run video generation
      </ShellButton>
    </NodeShell>
  );
}, isSameNodeRender);

const LlmGeneratorNode = memo(function LlmGeneratorNode({
  id,
  data,
  selected,
}: NodeProps<LlmGeneratorNodeData>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const { getGeneratorInputs, runNode } = useStudioContext();
  const inputs = getGeneratorInputs(id);
  const inputHandleSignature = inputs.map((handle) => handle.id).join("|");

  useEffect(() => {
    inputHandleSignature;
    updateNodeInternals(id);
  }, [id, inputHandleSignature, updateNodeInternals]);

  return (
    <NodeShell
      data={data}
      headerDetail={<WorkflowExecutionCostBadge nodeId={id} />}
      id={id}
      inputs={inputs}
      output={{ id: "text", label: "Text", color: "#f59e0b" }}
      selected={selected}
    >
      <GeneratedTextPreview
        text={data.outputLanes.filter(Boolean).join("\n\n") || null}
      />

      <GeneratorReviewPanel
        nodeId={id}
        review={data.review}
        reviewEnabled={data.reviewEnabled}
        valueType="text"
      />

      <ShellButton
        className="w-full justify-center"
        onClick={() => void runNode(id)}
      >
        Run LLM
      </ShellButton>
    </NodeShell>
  );
}, isSameNodeRender);

export const nodeTypes = {
  list: ListNode,
  prompt: PromptNode,
  asset: AssetNode,
  laneReorder: LaneReorderNode,
  laneSelect: LaneSelectNode,
  laneSplit: LaneSplitNode,
  laneMerge: LaneMergeNode,
  laneZipAlign: LaneZipAlignNode,
  laneAccumulator: LaneAccumulatorNode,
  imageGenerator: ImageGeneratorNode,
  videoGenerator: VideoGeneratorNode,
  llmGenerator: LlmGeneratorNode,
};
