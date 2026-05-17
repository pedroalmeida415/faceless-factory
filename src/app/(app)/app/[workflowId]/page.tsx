import { Frame, FramePanel } from "~/components/ui/frame";
import { NodeEditor } from "./_components/node-editor";
import { NodeInspector } from "./_components/node-inspector";
import { NodePalette } from "./_components/node-palette";

export default function WorkflowPage() {
  return (
    <Frame className="flex h-screen">
      <FramePanel className="min-w-0 flex-1">
        <NodePalette />
        <NodeEditor />
      </FramePanel>
      <NodeInspector />
    </Frame>
  );
}
