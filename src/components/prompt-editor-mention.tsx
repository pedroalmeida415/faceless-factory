"use client";

import { autoUpdate, computePosition, flip, shift } from "@floating-ui/dom";
import { type Editor, Extension } from "@tiptap/core";
import type { MentionNodeAttrs, MentionOptions } from "@tiptap/extension-mention";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { posToDOMRect, ReactRenderer, type useEditor } from "@tiptap/react";
import type { SuggestionKeyDownProps, SuggestionProps } from "@tiptap/suggestion";

import { forwardRef, useImperativeHandle, useState } from "react";
import type { WorkflowPromptVariable } from "~/features/workflow/domain/nodes/prompt";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { Empty, EmptyContent } from "./ui/empty";
import { Frame, FramePanel } from "./ui/frame";

export type PromptEditorVariable = WorkflowPromptVariable;

type PromptEditorVariablesStorage = {
  variables: readonly PromptEditorVariable[];
};

declare module "@tiptap/core" {
  interface Storage {
    promptEditorVariables: PromptEditorVariablesStorage;
  }
}

type PromptEditorMentionItem = PromptEditorVariable & MentionNodeAttrs;

type PromptEditorMentionHandle = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

type PromptEditorMentionProps = SuggestionProps<PromptEditorMentionItem, MentionNodeAttrs>;

export const promptEditorMentionPluginKey = new PluginKey("prompt-editor-mention");
const promptEditorVariablesPluginKey = new PluginKey("prompt-editor-variables");

export const PromptEditorVariables = Extension.create<Record<string, never>, PromptEditorVariablesStorage>({
  name: "promptEditorVariables",
  addStorage() {
    return {
      variables: [],
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: promptEditorVariablesPluginKey,
        view: (view) => {
          const updateMentionDisplays = () =>
            updateRenderedMentionDisplays(view.dom, editor.storage.promptEditorVariables.variables);
          updateMentionDisplays();

          return {
            update: updateMentionDisplays,
          };
        },
      }),
    ];
  },
});

export function setPromptEditorVariables(editor: Editor, variables: readonly PromptEditorVariable[]) {
  editor.storage.promptEditorVariables.variables = variables;
  editor.view.dispatch(editor.state.tr.setMeta(promptEditorVariablesPluginKey, true));
}

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
        if (props.items.length === 0) {
          return false;
        }

        setSelectedIndex((current) => (current + props.items.length - 1) % props.items.length);
        return true;
      }

      if (event.key === "ArrowDown") {
        if (props.items.length === 0) {
          return false;
        }

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
    <Frame>
      <FramePanel className="overflow-hidden p-0">
        <div className="max-h-75 overflow-y-auto p-1">
          {props.items.length === 0 && (
            <Empty className="md:py-6">
              <EmptyContent>Connect nodes to reference them here.</EmptyContent>
            </Empty>
          )}
          {props.items.map((item, index) => {
            const highlighted = selectedItemIndex === index;

            return (
              <Button
                variant="ghost"
                className={cn(
                  "block h-auto! w-64 py-3 text-left text-sm transition-colors *:leading-none",
                  highlighted ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
                )}
                key={item.id}
                onClick={() => selectItem(index)}
                onMouseDown={(event) => event.preventDefault()}
              >
                <span className="mb-1 block font-medium">{item.label}</span>
                <span className="block truncate text-xs">{item.value?.trim() || "Empty"}</span>
              </Button>
            );
          })}
        </div>
      </FramePanel>
    </Frame>
  );
});

PromptEditorMention.displayName = "PromptEditorMention";

export function createMentionConfig() {
  return {
    HTMLAttributes: {
      class:
        "prompt-editor-mention align-baseline rounded-md border border-cyan-300/30 bg-cyan-300/10 px-1.5 py-0.5 font-medium text-cyan-100 whitespace-pre-wrap!",
    },
    renderHTML: ({ node, options }) => [
      "span",
      {
        ...options.HTMLAttributes,
        "data-prompt-mention": "true",
        "data-variable-id": node.attrs.id,
      },
      node.attrs.label ?? node.attrs.id,
    ],
    renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
    suggestion: {
      char: "@",
      pluginKey: promptEditorMentionPluginKey,
      items: ({ editor, query }) => {
        const normalizedQuery = query.trim().toLowerCase();
        const variables = editor.storage.promptEditorVariables.variables.filter(
          (variable) =>
            variable.label.toLowerCase().includes(normalizedQuery) ||
            variable.value?.toLowerCase().includes(normalizedQuery),
        );

        return variables;
      },
      render: () => {
        let component: ReactRenderer<PromptEditorMentionHandle, PromptEditorMentionProps> | null = null;
        let cleanupPositionUpdate: (() => void) | null = null;

        const destroy = () => {
          cleanupPositionUpdate?.();
          cleanupPositionUpdate = null;
          component?.element.remove();
          component?.destroy();
          component = null;
        };

        return {
          onExit: destroy,
          onKeyDown: (props) => {
            if (props.event.key === "Escape") {
              destroy();
              return true;
            }

            return component?.ref?.onKeyDown(props) ?? false;
          },
          onStart: (props) => {
            if (!props.editor.isFocused) {
              return;
            }

            component = new ReactRenderer(PromptEditorMention, {
              editor: props.editor,
              props,
            });

            document.body.appendChild(component.element);
            cleanupPositionUpdate = watchMentionListPosition(props.editor, component.element);
          },
          onUpdate: (props) => {
            if (!props.editor.isFocused) {
              destroy();
              return;
            }

            component?.updateProps(props);
          },
        };
      },
    },
  } satisfies Partial<MentionOptions<PromptEditorMentionItem, MentionNodeAttrs>>;
}

function updateRenderedMentionDisplays(root: HTMLElement, variables: readonly PromptEditorVariable[]) {
  const displayTextByVariableId = new Map(variables.map((variable) => [variable.id, variable.displayText]));

  for (const element of root.querySelectorAll<HTMLElement>("[data-prompt-mention='true']")) {
    const variableId = element.dataset.variableId;
    const displayText = variableId ? displayTextByVariableId.get(variableId) : null;

    if (displayText) {
      element.textContent = displayText;
      element.title = displayText;
    }
  }
}

function watchMentionListPosition(editor: NonNullable<ReturnType<typeof useEditor>>, element: HTMLElement) {
  const virtualElement = {
    contextElement: editor.view.dom,
    getBoundingClientRect: () => posToDOMRect(editor.view, editor.state.selection.from, editor.state.selection.to),
  };

  function updatePosition() {
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

  return autoUpdate(virtualElement, element, () => updatePosition(), {
    animationFrame: true,
  });
}
