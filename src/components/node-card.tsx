"use client";

import type { useRender } from "@base-ui/react/use-render";
import type React from "react";
import { Card, CardAction, CardHeader, CardPanel, CardTitle } from "~/components/ui/card";
import { cn } from "~/lib/utils";

export function NodeCard({ className, render, ...props }: useRender.ComponentProps<"div">): React.ReactElement {
  return <Card className={cn("max-h-159 w-115", className)} render={render} {...props} />;
}

export function NodeCardPanel({ className, render, ...props }: useRender.ComponentProps<"div">): React.ReactElement {
  return <CardPanel className={cn("min-h-0 overflow-y-auto", className)} render={render} {...props} />;
}

export {
  CardAction as NodeCardAction,
  CardHeader as NodeCardHeader,
  CardTitle as NodeCardTitle,
  NodeCardPanel as NodeCardContent,
};
