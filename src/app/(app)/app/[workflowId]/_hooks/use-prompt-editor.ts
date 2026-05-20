import Document from "@tiptap/extension-document";
import Mention from "@tiptap/extension-mention";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { CharacterCount, UndoRedo } from "@tiptap/extensions";
import { useEditor } from "@tiptap/react";
import { useMemo } from "react";
import { suggestion } from "~/components/prompt-editor-mention";


export function usePromptEditor() {
  const extensions = useMemo(
    () => [
      Document,
      Paragraph,
      Text,
      Mention.configure({
        suggestion,
      }),
      Placeholder.configure({ placeholder: "Write a prompt. Type @ to insert mentions." }),
      CharacterCount.configure({ limit: 10000 }),
      UndoRedo
    ],
    [],
  );

  const editorProps = useMemo(
    () => ({
      attributes: {
        class: "min-h-40 outline-none",
      },
    }),
    [],
  );

  const editor = useEditor({
    editorProps,
    extensions,
    immediatelyRender: false,
  });

  return editor;
}
