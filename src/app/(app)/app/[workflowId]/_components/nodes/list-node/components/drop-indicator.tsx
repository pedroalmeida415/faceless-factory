import { cn } from "~/lib/utils";

export function DropIndicator({ closestEdge }: { readonly closestEdge: "top" | "bottom" }) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute left-1/2 z-10 h-0.5 w-1/2 -translate-x-1/2 rounded-full bg-ring",
        closestEdge === "top" ? "top-0 -translate-y-1/2" : "bottom-0 translate-y-1/2",
      )}
    />
  );
}
