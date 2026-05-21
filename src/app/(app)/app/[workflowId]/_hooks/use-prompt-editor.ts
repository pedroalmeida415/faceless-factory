import Document from "@tiptap/extension-document";
import Mention from "@tiptap/extension-mention";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { CharacterCount, UndoRedo } from "@tiptap/extensions";
import { useEditor } from "@tiptap/react";
import { exitSuggestion } from "@tiptap/suggestion";
import { useEffect, useMemo } from "react";
import {
  createMentionConfig,
  type PromptEditorVariable,
  PromptEditorVariables,
  promptEditorMentionPluginKey,
  setPromptEditorVariables,
} from "~/components/prompt-editor-mention";
import type { WorkflowPromptNode } from "~/features/workflow/domain/graph";
import { WorkflowPromptDocumentSchema } from "~/features/workflow/domain/nodes/prompt";
import { useWorkflowStore } from "./use-workflow-store";

export function usePromptEditor(input: {
  readonly nodeId: string;
  readonly data: WorkflowPromptNode["data"];
  readonly variables: readonly PromptEditorVariable[];
}) {
  const updateNodeData = useWorkflowStore((store) => store.updateNodeData);

  const extensions = useMemo(
    () => [
      Document,
      Paragraph,
      Text,
      PromptEditorVariables,
      Mention.configure(createMentionConfig()),
      Placeholder.configure({ placeholder: "Write a prompt. Type @ to reference variables." }),
      CharacterCount.configure({ limit: 5000 }),
      UndoRedo,
    ],
    [],
  );

  const editorProps = useMemo(
    () => ({
      attributes: {
        "aria-label": "Prompt text",
        class:
          "min-h-40 outline-none [&_.is-editor-empty:first-child::before]:pointer-events-none [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)]",
        role: "textbox",
      },
    }),
    [],
  );

  const editor = useEditor({
    content: input.data.document,
    editorProps,
    extensions,
    immediatelyRender: false,
    onCreate: ({ editor }) => {
      setPromptEditorVariables(editor, input.variables);
    },
    onBlur: ({ editor }) => {
      exitSuggestion(editor.view, promptEditorMentionPluginKey);

      const newData = structuredClone(input.data);
      newData.document = WorkflowPromptDocumentSchema.parse(editor.getJSON());
      updateNodeData(input.nodeId, newData);
    },
  });

  useEffect(() => {
    if (!editor) {
      return;
    }

    setPromptEditorVariables(editor, input.variables);
  }, [editor, input.variables]);

  return editor;
}
