import { CheckIcon, GripVerticalIcon, PencilIcon, Trash2Icon, XIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Fieldset } from "~/components/ui/fieldset";
import { Textarea } from "~/components/ui/textarea";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "~/components/ui/toolbar";
import type { WorkflowListNode } from "~/features/workflow/domain/graph";
import { cn } from "~/lib/utils";
import { type OnListItemReorder, useDraggableListItem } from "../_hooks/use-draggable-list-item";
import { DropIndicator } from "./drop-indicator";

type ListItemData = WorkflowListNode["data"]["items"][number];

const focusableEditingFieldsetTargetSelector = "button,a,input,textarea,select,[tabindex]";

export function TextListItem({
  index,
  instanceId,
  isEditing,
  item,
  onBeginEdit,
  onCancel,
  onCommit,
  onKeyDown,
  onRemove,
  onReorder,
}: {
  readonly index: number;
  readonly instanceId: symbol;
  readonly isEditing: boolean;
  readonly item: ListItemData;
  readonly onBeginEdit: (itemId: string) => void;
  readonly onCancel: (itemId: string) => void;
  readonly onCommit: (itemId: string, text: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, itemId: string, draft: string) => void;
  readonly onRemove: (itemId: string) => void;
  readonly onReorder: OnListItemReorder;
}) {
  const [draft, setDraft] = useState(item.text);
  const isPointerDownInsideEditingFieldsetRef = useRef(false);
  const localTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const { closestEdge, dragHandleRef, isDragging, itemRef } = useDraggableListItem({
    index,
    instanceId,
    itemId: item.id,
    onReorder,
    previewText: item.text,
  });

  useEffect(() => {
    if (!isEditing) {
      setDraft(item.text);
    }
  }, [isEditing, item.text]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    localTextareaRef.current?.focus();
    localTextareaRef.current?.select();
  }, [isEditing]);

  if (isEditing) {
    return (
      <Fieldset
        aria-label={`Editing list item ${index + 1}`}
        className="nodrag relative rounded-lg bg-muted px-3 py-4"
        onBlur={(event) => {
          const nextFocusedElement = event.relatedTarget instanceof globalThis.Node ? event.relatedTarget : null;

          if (
            isPointerDownInsideEditingFieldsetRef.current ||
            (nextFocusedElement && event.currentTarget.contains(nextFocusedElement))
          ) {
            return;
          }

          onCommit(item.id, draft);
        }}
        onPointerDownCapture={(event) => {
          const target = event.target;
          isPointerDownInsideEditingFieldsetRef.current = true;

          globalThis.setTimeout(() => {
            isPointerDownInsideEditingFieldsetRef.current = false;
          }, 0);

          if (
            target instanceof globalThis.Element &&
            event.currentTarget.contains(target.closest(focusableEditingFieldsetTargetSelector))
          ) {
            return;
          }

          event.preventDefault();
          localTextareaRef.current?.focus({ preventScroll: true });
        }}
      >
        <Textarea
          aria-label={`List item ${index + 1} text`}
          className="block **:data-[slot=textarea]:block **:data-[slot=textarea]:resize-none **:data-[slot=textarea]:px-0 **:data-[slot=textarea]:py-0"
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => onKeyDown(event, item.id, draft)}
          ref={localTextareaRef}
          placeholder="Empty"
          size="lg"
          value={draft}
          unstyled
        />
        <Toolbar className="absolute right-3 bottom-3">
          <ToolbarGroup>
            <ToolbarButton
              render={
                <Button
                  aria-label={`Cancel editing list item ${index + 1}`}
                  onClick={() => onCancel(item.id)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <XIcon aria-hidden="true" />
            </ToolbarButton>
            <ToolbarButton
              render={
                <Button
                  aria-label={`Save list item ${index + 1}`}
                  onClick={() => onCommit(item.id, draft)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <CheckIcon aria-hidden="true" />
            </ToolbarButton>
          </ToolbarGroup>
        </Toolbar>
      </Fieldset>
    );
  }

  const trimmedText = item.text.trim();

  return (
    <div ref={itemRef} className={cn("nodrag relative transition-opacity", isDragging && "opacity-40")}>
      <div className="group/list-item flex items-center gap-4 rounded-lg px-3 py-4 transition-colors focus-within:bg-muted hover:bg-muted">
        <div className="grid w-full grid-cols-[1fr_auto] grid-rows-1 items-center gap-3">
          <div className={cn("line-clamp-2", !trimmedText && "text-muted-foreground")}>{trimmedText || "Empty"}</div>
          <span className="text-muted-foreground tabular-nums">#{index + 1}</span>
        </div>
        <Toolbar className="absolute right-3 opacity-0 transition-opacity group-focus-within/list-item:opacity-100 group-hover/list-item:opacity-100">
          <ToolbarGroup>
            <ToolbarButton
              render={
                <Button
                  aria-label={`Edit list item ${index + 1}`}
                  onClick={() => onBeginEdit(item.id)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                />
              }
            >
              <PencilIcon aria-hidden="true" />
            </ToolbarButton>
            <ToolbarButton
              render={
                <Button
                  aria-label={`Remove list item ${index + 1}`}
                  className="hover:text-destructive"
                  onClick={() => onRemove(item.id)}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                />
              }
            >
              {" "}
              <Trash2Icon aria-hidden="true" />
            </ToolbarButton>
          </ToolbarGroup>
          <ToolbarSeparator />
          <ToolbarButton
            render={
              <Button
                aria-label={`Drag list item ${index + 1}`}
                className="cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
                ref={dragHandleRef}
                size="icon-sm"
                variant="ghost"
              />
            }
          >
            {" "}
            <GripVerticalIcon aria-hidden="true" />
          </ToolbarButton>
        </Toolbar>
      </div>
      {closestEdge ? <DropIndicator closestEdge={closestEdge} /> : null}
    </div>
  );
}
