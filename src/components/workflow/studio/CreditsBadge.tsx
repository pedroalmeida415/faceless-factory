"use client";

import Link from "next/link";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useWorkflowStudioStore } from "~/components/workflow/studio/store";
import { api } from "~/trpc/react";

function formatCreditsLabel(credits: number) {
  return `${credits} credit${credits === 1 ? "" : "s"}`;
}

export function WorkflowCreditsBadge() {
  const lastKnownCredits = useWorkflowStudioStore(
    (state) => state.lastKnownCredits,
  );
  const creditsQuery = api.workflow.getCredits.useQuery(undefined, {
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });
  const credits = lastKnownCredits ?? creditsQuery.data ?? null;
  const label =
    credits !== null
      ? `${formatCreditsLabel(credits.available)} left`
      : creditsQuery.isLoading
        ? "Checking credits"
        : "Credits unavailable";

  return (
    <div className="absolute top-4 right-4 z-20 flex items-center gap-2">
      <Badge
        className="h-auto rounded-full border border-border/60 bg-background/88 px-3 py-1.5 text-[11px] uppercase tracking-[0.18em] shadow-2xl backdrop-blur-xl"
        variant="outline"
      >
        {label}
      </Badge>
      <Button asChild size="xs" variant="outline">
        <Link href="/app/billing">Billing</Link>
      </Button>
    </div>
  );
}
