import { Handle, Position } from "@xyflow/react";

export function SocketRow({
  id,
  label,
  muted = false,
  required = false,
}: {
  readonly id: string;
  readonly label: string;
  readonly muted?: boolean;
  readonly required?: boolean;
}) {
  return (
    <div className={muted ? "text-muted-foreground" : undefined}>
      <Handle id={id} position={Position.Left} type="target" />
      <span>{label}</span>
      {required ? <span>*</span> : null}
    </div>
  );
}
