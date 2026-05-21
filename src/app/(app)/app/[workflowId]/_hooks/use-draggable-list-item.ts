"use client";

import { combine } from "@atlaskit/pragmatic-drag-and-drop/combine";
import {
  draggable,
  dropTargetForElements,
  type ElementDropTargetEventBasePayload,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { pointerOutsideOfPreview } from "@atlaskit/pragmatic-drag-and-drop/element/pointer-outside-of-preview";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { useEffect, useRef, useState } from "react";

export type ClosestEdge = "top" | "bottom";
export type OnListItemReorder = (args: {
  readonly sourceId: string;
  readonly targetId: string;
  readonly closestEdge: ClosestEdge;
}) => void;

const listItemKey = Symbol("list-item");

type ListItemDragData = {
  [listItemKey]: true;
  itemId: string;
  index: number;
  instanceId: symbol;
};

type ListItemDropData = ListItemDragData & {
  closestEdge: ClosestEdge;
};

function isListItemDragData(data: Record<string | symbol, unknown>): data is ListItemDragData {
  return data[listItemKey] === true;
}

function isListItemDropData(data: Record<string | symbol, unknown>): data is ListItemDropData {
  const closestEdge = data.closestEdge;
  return isListItemDragData(data) && (closestEdge === "top" || closestEdge === "bottom");
}

function getClosestEdge(element: HTMLElement, input: { readonly clientY: number }): ClosestEdge {
  const rect = element.getBoundingClientRect();
  return input.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
}

function renderListItemDragPreview({ container, text }: { readonly container: HTMLElement; readonly text: string }) {
  const preview = document.createElement("div");
  preview.className =
    "block max-w-72 truncate rounded-md border border-border bg-popover px-2 py-1 text-base text-popover-foreground shadow-md";
  preview.textContent = text || "Empty list item";
  container.append(preview);

  return () => preview.remove();
}

export function reorderListItems<TItem extends { readonly id: string }>({
  items,
  sourceId,
  targetId,
  closestEdge,
}: {
  readonly items: readonly TItem[];
  readonly sourceId: string;
  readonly targetId: string;
  readonly closestEdge: ClosestEdge;
}): TItem[] | null {
  if (sourceId === targetId) {
    return null;
  }

  const startIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);

  if (startIndex === -1 || targetIndex === -1) {
    return null;
  }

  const finishIndex =
    startIndex < targetIndex
      ? closestEdge === "bottom"
        ? targetIndex
        : targetIndex - 1
      : closestEdge === "top"
        ? targetIndex
        : targetIndex + 1;

  if (finishIndex === startIndex) {
    return null;
  }

  const nextItems = [...items];
  const [item] = nextItems.splice(startIndex, 1);

  if (!item) {
    return null;
  }

  nextItems.splice(Math.max(0, Math.min(finishIndex, nextItems.length)), 0, item);
  return nextItems;
}

export function useDraggableListItem({
  itemId,
  index,
  instanceId,
  onReorder,
  previewText,
}: {
  readonly itemId: string;
  readonly index: number;
  readonly instanceId: symbol;
  readonly onReorder: OnListItemReorder;
  readonly previewText: string;
}) {
  const [closestEdge, setClosestEdge] = useState<ClosestEdge | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const itemRef = useRef<HTMLDivElement>(null);
  const dragHandleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = itemRef.current;
    const dragHandle = dragHandleRef.current;

    if (!element || !dragHandle) {
      return;
    }

    const itemData = {
      [listItemKey]: true,
      itemId,
      index,
      instanceId,
    } satisfies ListItemDragData;

    function onDropTargetChange({ self, source }: ElementDropTargetEventBasePayload) {
      if (source.element === dragHandle) {
        setClosestEdge(null);
        return;
      }

      if (!isListItemDragData(source.data) || !isListItemDropData(self.data)) {
        setClosestEdge(null);
        return;
      }

      const edge = self.data.closestEdge;
      const isItemBeforeSource = index === source.data.index - 1;
      const isItemAfterSource = index === source.data.index + 1;

      if ((isItemBeforeSource && edge === "bottom") || (isItemAfterSource && edge === "top")) {
        setClosestEdge(null);
        return;
      }

      setClosestEdge(edge);
    }

    return combine(
      draggable({
        element: dragHandle,
        getInitialData: () => itemData,
        onGenerateDragPreview({ nativeSetDragImage }) {
          setCustomNativeDragPreview({
            nativeSetDragImage,
            getOffset: pointerOutsideOfPreview({ x: "12px", y: "8px" }),
            render({ container }) {
              return renderListItemDragPreview({ container, text: previewText });
            },
          });
        },
        onDragStart() {
          setIsDragging(true);
        },
        onDrop() {
          setIsDragging(false);
        },
      }),
      dropTargetForElements({
        element,
        canDrop({ source }) {
          return isListItemDragData(source.data) && source.data.instanceId === instanceId;
        },
        getData({ input }) {
          return {
            ...itemData,
            closestEdge: getClosestEdge(element, input),
          } satisfies ListItemDropData;
        },
        onDrag: onDropTargetChange,
        onDragEnter: onDropTargetChange,
        onDragLeave() {
          setClosestEdge(null);
        },
        onDrop({ self, source }) {
          setClosestEdge(null);

          if (!isListItemDragData(source.data) || !isListItemDropData(self.data)) {
            return;
          }

          onReorder({
            sourceId: source.data.itemId,
            targetId: self.data.itemId,
            closestEdge: self.data.closestEdge,
          });
        },
      }),
    );
  }, [index, instanceId, itemId, onReorder, previewText]);

  return {
    closestEdge,
    dragHandleRef,
    isDragging,
    itemRef,
  };
}
