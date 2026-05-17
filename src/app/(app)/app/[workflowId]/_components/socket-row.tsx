import { Handle, Position } from "@xyflow/react";

export function SocketRow({
  handleTop,
  id,
  label,
  muted = false,
}: {
  readonly handleTop?: number;
  readonly id: string;
  readonly label: string;
  readonly muted?: boolean;
}) {
  return (
    <Handle
      id={id}
      position={Position.Left}
      style={handleTop === undefined ? undefined : { top: handleTop }}
      type="target"
      className="flex flex-row-reverse items-center"
    >
      <span
        className={`pointer-events-none z-10 mr-4 text-xs/0 opacity-0 transition-opacity group-hover:opacity-100 ${muted ? "text-muted-foreground" : "text-white"} whitespace-nowrap`}
      >
        {label}
      </span>
    </Handle>
  );
}
