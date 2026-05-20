"use client";

import { computePosition, flip, shift } from "@floating-ui/dom";
import type { MentionNodeAttrs } from "@tiptap/extension-mention";
import { posToDOMRect, ReactRenderer, type useEditor } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from "@tiptap/suggestion";

import { forwardRef, useImperativeHandle, useState } from "react";
import { cn } from "~/lib/utils";

type PromptEditorMentionItem = MentionNodeAttrs & {
  type: "variable" | "add";
  value?: string | null;
};

type PromptEditorMentionHandle = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

type PromptEditorMentionProps = SuggestionProps<PromptEditorMentionItem, MentionNodeAttrs>;

export const PromptEditorMention = forwardRef<PromptEditorMentionHandle, PromptEditorMentionProps>((props, ref) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedItemIndex = Math.min(selectedIndex, props.items.length - 1);

  const selectItem = (index: number) => {
    const item = props.items[index];
    if (!item) {
      return;
    }

    props.command({ id: item.id, label: item.label, mentionSuggestionChar: item.mentionSuggestionChar });
  };

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (event.key === "ArrowUp") {
        setSelectedIndex((current) => (current + props.items.length - 1) % props.items.length);
        return true;
      }

      if (event.key === "ArrowDown") {
        setSelectedIndex((current) => (current + 1) % props.items.length);
        return true;
      }

      if (event.key === "Enter") {
        selectItem(selectedItemIndex);
        return true;
      }

      return false;
    },
  }));

  return (
    <div className="z-50 w-64 overflow-hidden rounded-lg border border-border/70 bg-background/95 p-1 shadow-xl">
      <div className="max-h-56 overflow-y-auto">
        {props.items.map((item, index) => {
          const selected = selectedItemIndex === index;

          if (item.type === "add") {
            return (
              <div className={cn(index > 0 ? "mt-1 border-t pt-1" : "")} key={item.id}>
                <button
                  className={cn(
                    "flex w-full rounded-md px-2 py-2 text-left text-sm transition-colors",
                    selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                  )}
                  onClick={() => selectItem(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  type="button"
                >
                  + Add variable
                </button>
              </div>
            );
          }

          return (
            <button
              className={cn(
                "flex w-full flex-col rounded-md px-2 py-2 text-left text-sm transition-colors",
                selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
              )}
              key={item.id}
              onClick={() => selectItem(index)}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              <span className="font-medium">{item.label}</span>
              <span className="truncate text-muted-foreground text-xs">
                {item.value?.trim() || "No input connected"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
});

PromptEditorMention.displayName = "PromptEditorMention";

export const suggestion = {
  char: "@",
  items: ({ query }) => [],
  render: () => {
    let component: ReactRenderer<PromptEditorMentionHandle, PromptEditorMentionProps> | null = null;

    return {
      onExit: () => {
        component?.element.remove();
        component?.destroy();
        component = null;
      },
      onKeyDown: (props) => {
        if (props.event.key === "Escape") {
          component?.element.remove();
          component?.destroy();
          component = null;
          return true;
        }

        return component?.ref?.onKeyDown(props) ?? false;
      },
      onStart: (props) => {
        component = new ReactRenderer(PromptEditorMention, {
          editor: props.editor,
          props,
        });

        component.element.style.position = "fixed";
        document.body.appendChild(component.element);
        updateMentionListPosition(props.editor, component.element);
      },
      onUpdate: (props) => {
        component?.updateProps(props);
        if (component) {
          updateMentionListPosition(props.editor, component.element);
        }
      },
    };
  },
} satisfies Omit<SuggestionOptions<any, MentionNodeAttrs>, "editor">;

function updateMentionListPosition(editor: NonNullable<ReturnType<typeof useEditor>>, element: HTMLElement) {
  const virtualElement = {
    getBoundingClientRect: () => posToDOMRect(editor.view, editor.state.selection.from, editor.state.selection.to),
  };

  void computePosition(virtualElement, element, {
    middleware: [shift(), flip()],
    placement: "bottom-start",
    strategy: "fixed",
  }).then(({ x, y, strategy }) => {
    element.style.left = `${x}px`;
    element.style.position = strategy;
    element.style.top = `${y}px`;
    element.style.width = "max-content";
  });
}
