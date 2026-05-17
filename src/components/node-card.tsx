"use client";

import type { useRender } from "@base-ui/react/use-render";
import type React from "react";
import { Card, CardAction, CardFooter, CardHeader, CardPanel, CardTitle } from "~/components/ui/card";
import { cn } from "~/lib/utils";

export function NodeCard({ className, render, ...props }: useRender.ComponentProps<"div">): React.ReactElement {
  return <Card className={cn("w-115", className)} render={render} {...props} />;
}

export {
  CardAction as NodeCardAction,
  CardFooter as NodeCardFooter,
  CardHeader as NodeCardHeader,
  CardPanel as NodeCardPanel,
  CardTitle as NodeCardTitle,
};
