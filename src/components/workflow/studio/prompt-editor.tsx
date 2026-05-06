"use client";

import { Node as TiptapNode } from "@tiptap/core";
import CharacterCount from "@tiptap/extension-character-count";
import TiptapDocument from "@tiptap/extension-document";
import Dropcursor from "@tiptap/extension-dropcursor";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import type { DOMOutputSpec, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type Editor, EditorContent, useEditor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { PROMPT_VARIABLE_PATTERN } from "~/features/workflow/node-definitions";
import type {
  PromptDisplayMode,
  PromptVariable,
} from "~/features/workflow/types";
import { cn } from "~/lib/utils";

const VARIABLE_TAG_NAME = "promptVariable";
const MENTION_TAG_NAME = "@mention";
const EMPTY_VARIABLE_VALUE = "None";
const TAG_KEY_ATTR = "data-prompt-variable-key";
const TAG_LABEL_ATTR = "data-prompt-variable-label";
const TAG_VALUE_ATTR = "data-prompt-variable-value";
const TAG_SHOW_LABEL_ATTR = "data-prompt-variable-show-label";
const TAG_SHOW_VALUE_ATTR = "data-prompt-variable-show-value";
const PROMPT_CHANGE_COMMIT_DELAY_MS = 150;

type PromptEditorVariable = PromptVariable & {
  value: string | null;
};

type MentionMenuState = {
  activeIndex: number;
  queryText: string;
  x: number;
  y: number;
};

type EditorJsonContent = {
  attrs?: Record<string, unknown>;
  content?: EditorJsonContent[];
  text?: string;
  type: string;
};

function getVariableDisplay(
  variable: PromptEditorVariable,
  displayMode: PromptDisplayMode,
) {
  const value = variable.value?.trim() ? variable.value : EMPTY_VARIABLE_VALUE;

  switch (displayMode) {
    case "source":
      return {
        label: variable.label,
        showLabel: true,
        showValue: false,
        value,
      };
    case "value":
      return {
        label: variable.label,
        showLabel: false,
        showValue: true,
        value,
      };
    default:
      return {
        label: `${variable.label}: `,
        showLabel: true,
        showValue: true,
        value,
      };
  }
}

function buildParagraphContent(
  line: string,
  variableByKey: Map<string, PromptEditorVariable>,
  displayMode: PromptDisplayMode,
) {
  const content: EditorJsonContent[] = [];
  let lastIndex = 0;

  PROMPT_VARIABLE_PATTERN.lastIndex = 0;

  while (true) {
    const match = PROMPT_VARIABLE_PATTERN.exec(line);
    if (!match) {
      break;
    }

    const key = match[1];
    const start = match.index;
    const end = start + match[0].length;

    if (start > lastIndex) {
      content.push({
        text: line.slice(lastIndex, start),
        type: "text",
      });
    }

    const variable = key ? variableByKey.get(key) : null;
    if (variable) {
      content.push({
        attrs: {
          tagKey: variable.key,
          ...getVariableDisplay(variable, displayMode),
        },
        type: VARIABLE_TAG_NAME,
      });
    } else {
      content.push({
        text: match[0],
        type: "text",
      });
    }

    lastIndex = end;
  }

  if (lastIndex < line.length) {
    content.push({
      text: line.slice(lastIndex),
      type: "text",
    });
  }

  return content;
}

function buildEditorContent(
  value: string,
  variables: PromptEditorVariable[],
  displayMode: PromptDisplayMode,
) {
  const variableByKey = new Map(
    variables.map((variable) => [variable.key, variable]),
  );

  return value.split("\n").map((line) => {
    const content = buildParagraphContent(line, variableByKey, displayMode);

    return {
      content: content.length ? content : undefined,
      type: "paragraph",
    } satisfies EditorJsonContent;
  });
}

function serializePromptNode(node: ProseMirrorNode) {
  if (node.type.name === VARIABLE_TAG_NAME) {
    const tagKey = node.attrs.tagKey;
    return typeof tagKey === "string" && tagKey !== MENTION_TAG_NAME
      ? `{{${tagKey}}}`
      : "";
  }

  if (node.isText) {
    return node.text ?? "";
  }

  let text = "";
  node.forEach((child) => {
    text += serializePromptNode(child);
  });
  return text;
}

function extractTextFromEditor(editor: Editor) {
  const paragraphs: string[] = [];

  editor.state.doc.forEach((node) => {
    paragraphs.push(serializePromptNode(node));
  });

  return paragraphs.join("\n");
}

function findMentionTrigger(editor: Editor) {
  let position = -1;
  let queryText = "";

  editor.state.doc.descendants((node, pos) => {
    if (
      node.type.name === VARIABLE_TAG_NAME &&
      node.attrs.tagKey === MENTION_TAG_NAME
    ) {
      position = pos;
      queryText =
        typeof node.attrs.queryText === "string" ? node.attrs.queryText : "";
      return false;
    }

    return true;
  });

  return { position, queryText };
}

function removeMentionTrigger(editor: Editor, keepText: boolean) {
  const mention = findMentionTrigger(editor);
  if (mention.position < 0) {
    return;
  }

  const chain = editor
    .chain()
    .focus()
    .deleteRange({ from: mention.position, to: mention.position + 1 });

  if (keepText) {
    chain.insertContentAt(mention.position, `@${mention.queryText}`);
  }

  chain.run();
}

function updateMentionQuery(editor: Editor, queryText: string) {
  const mention = findMentionTrigger(editor);
  if (mention.position < 0) {
    return false;
  }

  const node = editor.state.doc.nodeAt(mention.position);
  if (!node) {
    return false;
  }

  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(mention.position, undefined, {
      ...node.attrs,
      queryText,
    }),
  );

  return true;
}

function insertVariableTag(
  editor: Editor,
  variable: PromptEditorVariable,
  displayMode: PromptDisplayMode,
  insertAtEnd = false,
) {
  if (insertAtEnd) {
    editor.commands.focus("end");
  }

  const position = editor.state.selection.from;
  editor
    .chain()
    .focus()
    .insertContentAt(position, {
      attrs: {
        tagKey: variable.key,
        ...getVariableDisplay(variable, displayMode),
      },
      type: VARIABLE_TAG_NAME,
    })
    .run();

  requestAnimationFrame(() => {
    editor
      .chain()
      .focus()
      .setTextSelection(position + 1)
      .run();
  });
}

function insertVariableTagAtMention(
  editor: Editor,
  variable: PromptEditorVariable,
  displayMode: PromptDisplayMode,
) {
  const mention = findMentionTrigger(editor);
  if (mention.position < 0) {
    return;
  }

  editor
    .chain()
    .focus()
    .deleteRange({ from: mention.position, to: mention.position + 1 })
    .insertContentAt(mention.position, {
      attrs: {
        tagKey: variable.key,
        ...getVariableDisplay(variable, displayMode),
      },
      type: VARIABLE_TAG_NAME,
    })
    .run();

  requestAnimationFrame(() => {
    editor
      .chain()
      .focus()
      .setTextSelection(mention.position + 1)
      .run();
  });
}

function syncVariableTagDisplays(
  editor: Editor,
  variables: PromptEditorVariable[],
  displayMode: PromptDisplayMode,
) {
  const variableByKey = new Map(
    variables.map((variable) => [variable.key, variable]),
  );
  const transaction = editor.state.tr;
  let modified = false;

  editor.state.doc.descendants((node, pos) => {
    if (
      node.type.name !== VARIABLE_TAG_NAME ||
      node.attrs.tagKey === MENTION_TAG_NAME
    ) {
      return true;
    }

    const key = typeof node.attrs.tagKey === "string" ? node.attrs.tagKey : "";
    const variable = variableByKey.get(key);
    if (!variable) {
      return true;
    }

    const nextAttrs = {
      tagKey: variable.key,
      ...getVariableDisplay(variable, displayMode),
    };
    const didChange = Object.entries(nextAttrs).some(
      ([entryKey, value]) => node.attrs[entryKey] !== value,
    );

    if (!didChange) {
      return true;
    }

    transaction.setNodeMarkup(pos, undefined, nextAttrs);
    modified = true;
    return true;
  });

  if (modified) {
    editor.view.dispatch(transaction);
  }
}

function createPromptVariableNode() {
  return TiptapNode.create({
    atom: true,
    group: "inline",
    inline: true,
    name: VARIABLE_TAG_NAME,
    selectable: true,

    addAttributes() {
      return {
        label: { default: "" },
        queryText: { default: "" },
        showLabel: { default: true },
        showValue: { default: true },
        tagKey: { default: "" },
        value: { default: "" },
      };
    },

    parseHTML() {
      return [{ tag: `span[${TAG_KEY_ATTR}]` }];
    },

    renderHTML({ HTMLAttributes }) {
      const tagKey =
        typeof HTMLAttributes.tagKey === "string" ? HTMLAttributes.tagKey : "";

      if (tagKey === MENTION_TAG_NAME) {
        const queryText =
          typeof HTMLAttributes.queryText === "string"
            ? HTMLAttributes.queryText
            : "";

        return [
          "span",
          {
            [TAG_KEY_ATTR]: tagKey,
            class:
              "inline-flex rounded-sm bg-primary/12 px-1 py-0.5 text-primary",
            contenteditable: "false",
          },
          `@${queryText}`,
        ] satisfies DOMOutputSpec;
      }

      const label =
        typeof HTMLAttributes.label === "string" ? HTMLAttributes.label : "";
      const value =
        typeof HTMLAttributes.value === "string" ? HTMLAttributes.value : "";
      const showLabel = Boolean(HTMLAttributes.showLabel);
      const showValue = Boolean(HTMLAttributes.showValue);
      const isEmpty = !value.trim() || value === EMPTY_VARIABLE_VALUE;
      const children: DOMOutputSpec[] = [];

      if (showLabel && label) {
        children.push([
          "span",
          {
            class: "text-[0.95em] text-primary/90",
          },
          label,
        ]);
      }

      if (showValue && value) {
        children.push([
          "span",
          {
            class: cn(
              "text-[0.95em]",
              isEmpty ? "text-muted-foreground" : "text-foreground",
            ),
          },
          value,
        ]);
      }

      return [
        "span",
        {
          [TAG_KEY_ATTR]: tagKey,
          [TAG_LABEL_ATTR]: label,
          [TAG_SHOW_LABEL_ATTR]: String(showLabel),
          [TAG_SHOW_VALUE_ATTR]: String(showValue),
          [TAG_VALUE_ATTR]: value,
          class:
            "mx-0.5 inline-flex items-center gap-0.5 rounded-sm bg-primary/12 px-1 py-0.5 align-baseline text-sm",
          contenteditable: "false",
        },
        ...children,
      ] satisfies DOMOutputSpec;
    },
  });
}

function getDisplayModeLabel(displayMode: PromptDisplayMode) {
  switch (displayMode) {
    case "source":
      return "Source";
    case "value":
      return "Value";
    default:
      return "Source + Value";
  }
}

export function PromptEditor({
  displayMode,
  onAddVariable,
  onChange,
  onDisplayModeChange,
  placeholder,
  value,
  variables,
}: {
  displayMode: PromptDisplayMode;
  onAddVariable: () => PromptVariable | null;
  onChange: (value: string) => void;
  onDisplayModeChange: (displayMode: PromptDisplayMode) => void;
  placeholder: string;
  value: string;
  variables: PromptEditorVariable[];
}) {
  const editorRef = useRef<Editor | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const commitTimerRef = useRef<ReturnType<
    typeof globalThis.setTimeout
  > | null>(null);
  const lastValueRef = useRef(value);
  const lastVariableKeysRef = useRef(
    variables.map((variable) => variable.key).join("|"),
  );
  const lastVariableDisplayRef = useRef(
    variables
      .map(
        (variable) =>
          `${variable.key}:${variable.label}:${variable.value ?? ""}`,
      )
      .join("|"),
  );
  const lastDisplayModeRef = useRef(displayMode);
  const addVariableFocusRef = useRef(false);
  const focusedRef = useRef(false);
  const onChangeRef = useRef(onChange);
  const propValueRef = useRef(value);
  const pendingChangeRef = useRef<string | null>(null);
  const pendingPropValueRef = useRef<string | null>(null);
  const handleEditorKeyDownRef = useRef<(event: KeyboardEvent) => boolean>(
    () => false,
  );
  const [mentionMenu, setMentionMenu] = useState<MentionMenuState | null>(null);
  const [initialContent] = useState(() => ({
    content: buildEditorContent(value, variables, displayMode),
    type: "doc",
  }));

  onChangeRef.current = onChange;
  propValueRef.current = value;

  const clearCommitTimer = useCallback(() => {
    if (commitTimerRef.current === null) {
      return;
    }

    globalThis.clearTimeout(commitTimerRef.current);
    commitTimerRef.current = null;
  }, []);

  const flushPendingChange = useCallback(() => {
    const pendingChange = pendingChangeRef.current;
    if (pendingChange === null) {
      return;
    }

    pendingChangeRef.current = null;
    clearCommitTimer();

    if (pendingChange === propValueRef.current) {
      pendingPropValueRef.current = null;
      return;
    }

    onChangeRef.current(pendingChange);
  }, [clearCommitTimer]);

  const scheduleChange = useCallback(
    (nextValue: string) => {
      if (nextValue === propValueRef.current) {
        pendingChangeRef.current = null;
        pendingPropValueRef.current = null;
        clearCommitTimer();
        return;
      }

      pendingChangeRef.current = nextValue;
      pendingPropValueRef.current = nextValue;
      clearCommitTimer();
      if (focusedRef.current) {
        return;
      }

      commitTimerRef.current = globalThis.setTimeout(
        flushPendingChange,
        PROMPT_CHANGE_COMMIT_DELAY_MS,
      );
    },
    [clearCommitTimer, flushPendingChange],
  );

  const filteredVariables = useMemo(() => {
    if (!mentionMenu?.queryText.trim()) {
      return variables;
    }

    const query = mentionMenu.queryText.trim().toLowerCase();
    return variables.filter(
      (variable) =>
        variable.key.toLowerCase().includes(query) ||
        variable.label.toLowerCase().includes(query),
    );
  }, [mentionMenu?.queryText, variables]);

  const menuItems = useMemo(
    () => [
      ...filteredVariables.map((variable) => ({
        type: "variable" as const,
        variable,
      })),
      { type: "add" as const },
    ],
    [filteredVariables],
  );

  const closeMentionMenu = useCallback((keepText: boolean) => {
    if (editorRef.current) {
      removeMentionTrigger(editorRef.current, keepText);
    }
    setMentionMenu(null);
  }, []);

  const commitMentionItem = useCallback(
    (index: number) => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }

      const item = menuItems[index];
      if (!item) {
        return;
      }

      if (item.type === "variable") {
        insertVariableTagAtMention(editor, item.variable, displayMode);
      } else {
        flushPendingChange();
        const createdVariable = onAddVariable();
        if (!createdVariable) {
          closeMentionMenu(true);
          return;
        }

        insertVariableTagAtMention(
          editor,
          {
            ...createdVariable,
            value: null,
          },
          displayMode,
        );
      }

      setMentionMenu(null);
    },
    [
      closeMentionMenu,
      displayMode,
      flushPendingChange,
      menuItems,
      onAddVariable,
    ],
  );

  const openMentionMenu = useCallback(() => {
    const editor = editorRef.current;
    const wrapper = wrapperRef.current;
    if (!editor || !wrapper) {
      return false;
    }

    const coords = editor.view.coordsAtPos(editor.state.selection.from);
    const rect = wrapper.getBoundingClientRect();

    editor
      .chain()
      .focus()
      .insertContent({
        attrs: {
          tagKey: MENTION_TAG_NAME,
        },
        type: VARIABLE_TAG_NAME,
      })
      .run();

    setMentionMenu({
      activeIndex: 0,
      queryText: "",
      x: coords.left - rect.left,
      y: coords.bottom - rect.top + 8,
    });

    return true;
  }, []);

  const handleEditorKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!editorRef.current) {
        return false;
      }

      if (mentionMenu) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeMentionMenu(true);
          return true;
        }

        if (event.key === "ArrowDown") {
          event.preventDefault();
          setMentionMenu((current) =>
            current
              ? {
                  ...current,
                  activeIndex: (current.activeIndex + 1) % menuItems.length,
                }
              : current,
          );
          return true;
        }

        if (event.key === "ArrowUp") {
          event.preventDefault();
          setMentionMenu((current) =>
            current
              ? {
                  ...current,
                  activeIndex:
                    (current.activeIndex - 1 + menuItems.length) %
                    menuItems.length,
                }
              : current,
          );
          return true;
        }

        if (event.key === "Enter") {
          event.preventDefault();
          commitMentionItem(mentionMenu.activeIndex);
          return true;
        }

        if (event.key === "Backspace") {
          event.preventDefault();

          if (!mentionMenu.queryText.length) {
            closeMentionMenu(false);
            return true;
          }

          const nextQuery = mentionMenu.queryText.slice(0, -1);
          updateMentionQuery(editorRef.current, nextQuery);
          setMentionMenu({
            ...mentionMenu,
            activeIndex: 0,
            queryText: nextQuery,
          });
          return true;
        }

        if (
          event.key.length === 1 &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey
        ) {
          event.preventDefault();
          const nextQuery = `${mentionMenu.queryText}${event.key}`;
          updateMentionQuery(editorRef.current, nextQuery);
          setMentionMenu({
            ...mentionMenu,
            activeIndex: 0,
            queryText: nextQuery,
          });
          return true;
        }
      }

      if (
        event.key === "@" &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        return openMentionMenu();
      }

      return false;
    },
    [
      closeMentionMenu,
      commitMentionItem,
      menuItems.length,
      mentionMenu,
      openMentionMenu,
    ],
  );

  handleEditorKeyDownRef.current = handleEditorKeyDown;

  const editorProps = useMemo(
    () => ({
      attributes: {
        class:
          "tiptap-prompt-editor min-h-40 whitespace-pre-wrap break-words text-sm leading-6 outline-none",
      },
      handleKeyDown: (_view: unknown, event: KeyboardEvent) =>
        handleEditorKeyDownRef.current(event),
    }),
    [],
  );

  const extensions = useMemo(
    () => [
      TiptapDocument.extend({
        content: "paragraph+",
      }),
      Paragraph,
      Text,
      createPromptVariableNode(),
      Dropcursor.configure({ color: "#f59e0b", width: 2 }),
      Placeholder.configure({ placeholder }),
      CharacterCount.configure({ limit: 20000 }),
    ],
    [placeholder],
  );

  const editor = useEditor({
    content: initialContent,
    editorProps,
    extensions,
    immediatelyRender: false,
    onCreate: ({ editor }) => {
      editorRef.current = editor;
    },
    onDestroy: () => {
      editorRef.current = null;
    },
    onBlur: () => {
      focusedRef.current = false;
      flushPendingChange();
    },
    onFocus: () => {
      focusedRef.current = true;
      clearCommitTimer();
    },
    onUpdate: ({ editor }) => {
      const nextValue = extractTextFromEditor(editor);
      if (nextValue !== lastValueRef.current) {
        lastValueRef.current = nextValue;
        scheduleChange(nextValue);
      }
    },
  });

  useEffect(() => () => flushPendingChange(), [flushPendingChange]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const currentValue = extractTextFromEditor(editor);
    const pendingPropValue = pendingPropValueRef.current;
    const variableKeys = variables.map((variable) => variable.key).join("|");
    const variableDisplay = variables
      .map(
        (variable) =>
          `${variable.key}:${variable.label}:${variable.value ?? ""}`,
      )
      .join("|");
    const keysChanged = variableKeys !== lastVariableKeysRef.current;
    const valueChanged = value !== currentValue;
    const isStalePropEcho =
      pendingPropValue !== null &&
      currentValue === pendingPropValue &&
      value !== pendingPropValue;
    const displayChanged =
      variableDisplay !== lastVariableDisplayRef.current ||
      displayMode !== lastDisplayModeRef.current;

    if (pendingPropValue !== null && value === pendingPropValue) {
      pendingPropValueRef.current = null;
    }

    if (valueChanged || keysChanged) {
      if (focusedRef.current && valueChanged) {
        if (keysChanged || displayChanged) {
          syncVariableTagDisplays(editor, variables, displayMode);
        }
        lastVariableKeysRef.current = variableKeys;
        lastVariableDisplayRef.current = variableDisplay;
        lastDisplayModeRef.current = displayMode;
        return;
      }

      if (isStalePropEcho) {
        if (keysChanged || displayChanged) {
          syncVariableTagDisplays(editor, variables, displayMode);
        }
        lastVariableKeysRef.current = variableKeys;
        lastVariableDisplayRef.current = variableDisplay;
        lastDisplayModeRef.current = displayMode;
        return;
      }

      editor.commands.setContent(
        {
          content: buildEditorContent(value, variables, displayMode),
          type: "doc",
        },
        { emitUpdate: false },
      );
      lastValueRef.current = value;
      pendingPropValueRef.current = null;
    } else if (displayChanged) {
      syncVariableTagDisplays(editor, variables, displayMode);
    }

    lastVariableKeysRef.current = variableKeys;
    lastVariableDisplayRef.current = variableDisplay;
    lastDisplayModeRef.current = displayMode;
  }, [displayMode, editor, value, variables]);

  useEffect(() => {
    setMentionMenu((current) =>
      current
        ? Math.min(current.activeIndex, menuItems.length - 1) ===
          current.activeIndex
          ? current
          : {
              ...current,
              activeIndex: Math.min(current.activeIndex, menuItems.length - 1),
            }
        : current,
    );
  }, [menuItems.length]);

  useEffect(() => {
    if (!mentionMenu) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof globalThis.Node &&
        wrapperRef.current?.contains(target)
      ) {
        return;
      }

      closeMentionMenu(true);
    };

    globalThis.document.addEventListener("mousedown", handlePointerDown);
    return () =>
      globalThis.document.removeEventListener("mousedown", handlePointerDown);
  }, [closeMentionMenu, mentionMenu]);

  const handleAddVariableClick = useCallback(() => {
    if (!editorRef.current) {
      return;
    }

    flushPendingChange();
    const createdVariable = onAddVariable();
    if (!createdVariable) {
      return;
    }

    insertVariableTag(
      editorRef.current,
      {
        ...createdVariable,
        value: null,
      },
      displayMode,
      !addVariableFocusRef.current,
    );
  }, [displayMode, flushPendingChange, onAddVariable]);

  return (
    <div className="nodrag nopan space-y-3" ref={wrapperRef}>
      <div className="relative">
        <div className="max-h-80 overflow-y-auto rounded-lg border bg-muted/20 px-3 py-3">
          <EditorContent editor={editor} />
        </div>

        {mentionMenu ? (
          <Card
            className="absolute z-20 w-64 overflow-hidden border-border/70 bg-background/95 p-1 shadow-xl"
            onMouseDown={(event) => event.preventDefault()}
            style={{ left: mentionMenu.x, top: mentionMenu.y }}
          >
            <div className="max-h-56 overflow-y-auto">
              {filteredVariables.map((variable, index) => {
                const selected = mentionMenu.activeIndex === index;

                return (
                  <button
                    className={cn(
                      "flex w-full flex-col rounded-md px-2 py-2 text-left text-sm transition-colors",
                      selected
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/60",
                    )}
                    key={variable.key}
                    onClick={() => commitMentionItem(index)}
                    type="button"
                  >
                    <span className="font-medium">{variable.label}</span>
                    <span className="truncate text-muted-foreground text-xs">
                      {variable.value?.trim() || "No input connected"}
                    </span>
                  </button>
                );
              })}
            </div>

            <div
              className={cn(
                filteredVariables.length ? "mt-1 border-t pt-1" : "",
              )}
            >
              <button
                className={cn(
                  "flex w-full rounded-md px-2 py-2 text-left text-sm transition-colors",
                  mentionMenu.activeIndex === menuItems.length - 1
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/60",
                )}
                onClick={() => commitMentionItem(menuItems.length - 1)}
                type="button"
              >
                + Add variable
              </button>
            </div>
          </Card>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3">
        <Button
          onClick={handleAddVariableClick}
          onMouseDown={() => {
            addVariableFocusRef.current = Boolean(editorRef.current?.isFocused);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          + Add variable
        </Button>

        {variables.length ? (
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground text-xs uppercase tracking-[0.24em]">
              Display
            </span>
            <Select
              onValueChange={(nextValue) => {
                flushPendingChange();
                onDisplayModeChange(nextValue as PromptDisplayMode);
              }}
              value={displayMode}
            >
              <SelectTrigger className="h-8 w-[160px] text-xs">
                <SelectValue>{getDisplayModeLabel(displayMode)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="source-value">Source + Value</SelectItem>
                <SelectItem value="value">Value</SelectItem>
                <SelectItem value="source">Source</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
    </div>
  );
}
