"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "~/client/trpc/react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import {
  BILLING_PLANS,
  CREDIT_TOP_UP_PACK_PRICE_CENTS,
  CREDIT_TOP_UP_PACK_SIZE,
  formatUsd,
  isBillingPlanName,
} from "~/features/billing/billing";

function formatBillingDate(value?: Date | null) {
  if (!value) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
  }).format(new Date(value));
}

function normalizeTopUpPacks(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.min(100, Math.max(1, Math.floor(value)));
}

export default function BillingPage() {
  const searchParams = useSearchParams();
  const autoCheckoutStartedRef = useRef(false);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [topUpPacks, setTopUpPacks] = useState(1);

  const overviewQuery = api.billing.getOverview.useQuery(undefined, {
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
  const utils = api.useUtils();

  const billingPortalMutation =
    api.billing.createBillingPortalSession.useMutation({
      onSuccess: (result) => {
        if (result.url) {
          window.location.assign(result.url);
        }
      },
    });
  const checkoutMutation =
    api.billing.createSubscriptionCheckoutSession.useMutation({
      onSuccess: (result) => {
        if (result.url) {
          window.location.assign(result.url);
        }
      },
    });
  const topUpMutation = api.billing.createTopUpCheckoutSession.useMutation({
    onSuccess: (result) => {
      window.location.assign(result.url);
    },
  });

  const activeSubscription = overviewQuery.data?.activeSubscription;
  const latestSubscription = overviewQuery.data?.latestSubscription;
  const checkoutSucceeded = searchParams.get("checkout") === "success";
  const selectedPlan = searchParams.get("plan");
  const selectedPlanName =
    typeof selectedPlan === "string" && isBillingPlanName(selectedPlan)
      ? selectedPlan
      : null;
  const selectedAnnual = searchParams.get("annual") === "1";
  const selectedIntent = searchParams.get("intent");

  useEffect(() => {
    if (selectedIntent !== "subscribe") {
      return;
    }

    if (!selectedPlanName || overviewQuery.isPending) {
      return;
    }

    if (autoCheckoutStartedRef.current) {
      return;
    }

    autoCheckoutStartedRef.current = true;
    setErrorMessage(null);

    checkoutMutation.mutate(
      {
        annual: selectedAnnual,
        plan: selectedPlanName,
      },
      {
        onError: (error) => {
          setErrorMessage(error.message);
        },
      },
    );
  }, [
    checkoutMutation,
    overviewQuery.isPending,
    selectedAnnual,
    selectedIntent,
    selectedPlanName,
  ]);

  async function refreshOverview() {
    await utils.billing.getOverview.invalidate();
  }

  return (
    <main className="min-h-screen bg-background px-6 py-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <Card className="border-border/60 bg-card/95 shadow-2xl shadow-black/10">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-2">
              <CardTitle className="text-2xl">Billing</CardTitle>
              <CardDescription>
                Manage subscription changes, open the Stripe billing portal, and
                top up credits without changing plans.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild type="button" variant="outline">
                <Link href="/app">Back to studio</Link>
              </Button>
              <Badge className="px-3 py-1 text-sm" variant="outline">
                {overviewQuery.data
                  ? `${overviewQuery.data.creditBalance.toLocaleString()} credits available`
                  : "Loading credits..."}
              </Badge>
            </div>
          </CardHeader>
        </Card>

        {checkoutSucceeded ? (
          <Card className="border-primary/40 bg-primary/8">
            <CardContent className="py-4 text-sm">
              Checkout completed. Stripe may still be finalizing webhook
              updates, so billing state and credits can take a moment to settle.
            </CardContent>
          </Card>
        ) : null}

        {errorMessage ? (
          <Card className="border-destructive/40 bg-destructive/8">
            <CardContent className="py-4 text-destructive text-sm">
              {errorMessage}
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[1.45fr_0.95fr]">
          <section className="space-y-6">
            <Card className="border-border/60 bg-card/95 shadow-black/5 shadow-xl">
              <CardHeader>
                <CardTitle>Plans</CardTitle>
                <CardDescription>
                  Annual plans bill yearly and still unlock their credits on a
                  monthly cadence.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-3">
                {BILLING_PLANS.map((plan) => {
                  const isCurrentAnnualPlan =
                    activeSubscription?.plan === plan.name &&
                    activeSubscription.billingInterval === "year";
                  const isCurrentMonthlyPlan =
                    activeSubscription?.plan === plan.name &&
                    activeSubscription.billingInterval === "month";

                  return (
                    <Card
                      className={[
                        "border-border/60 bg-background/70",
                        plan.featured ? "border-primary/50" : "",
                        activeSubscription?.plan === plan.name
                          ? "ring-2 ring-primary"
                          : "",
                      ].join(" ")}
                      key={plan.name}
                    >
                      <CardHeader>
                        <div className="flex items-center justify-between gap-3">
                          <CardTitle>{plan.title}</CardTitle>
                          {activeSubscription?.plan === plan.name ? (
                            <Badge>Current</Badge>
                          ) : null}
                        </div>
                        <CardDescription>{plan.description}</CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3 text-sm">
                        <div>
                          <div className="font-semibold text-2xl tracking-tight">
                            {formatUsd(plan.monthlyPriceCents)}
                            <span className="text-muted-foreground text-sm">
                              /mo
                            </span>
                          </div>
                          <div className="text-muted-foreground">
                            or {formatUsd(plan.annualPriceCents)} yearly
                          </div>
                        </div>
                        <div className="rounded-3xl border border-border/60 bg-muted/30 px-4 py-3">
                          <div className="text-[11px] text-muted-foreground uppercase tracking-[0.22em]">
                            Credits
                          </div>
                          <div className="mt-1 font-medium">
                            {plan.creditsPerMonth.toLocaleString()} / month
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            className="flex-1"
                            disabled={
                              isCurrentMonthlyPlan || checkoutMutation.isPending
                            }
                            onClick={() =>
                              checkoutMutation.mutate(
                                { annual: false, plan: plan.name },
                                {
                                  onError: (error) => {
                                    setErrorMessage(error.message);
                                  },
                                },
                              )
                            }
                            type="button"
                            variant={
                              activeSubscription?.plan === plan.name &&
                              activeSubscription.billingInterval === "month"
                                ? "default"
                                : "outline"
                            }
                          >
                            {activeSubscription?.plan === plan.name &&
                            activeSubscription.billingInterval === "month"
                              ? "Monthly active"
                              : "Monthly"}
                          </Button>
                          <Button
                            className="flex-1"
                            disabled={
                              isCurrentAnnualPlan || checkoutMutation.isPending
                            }
                            onClick={() =>
                              checkoutMutation.mutate(
                                { annual: true, plan: plan.name },
                                {
                                  onError: (error) => {
                                    setErrorMessage(error.message);
                                  },
                                },
                              )
                            }
                            type="button"
                            variant={
                              activeSubscription?.plan === plan.name &&
                              activeSubscription.billingInterval === "year"
                                ? "default"
                                : "outline"
                            }
                          >
                            {activeSubscription?.plan === plan.name &&
                            activeSubscription.billingInterval === "year"
                              ? "Annual active"
                              : "Annual"}
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </CardContent>
            </Card>

            <Card className="border-border/60 bg-card/95 shadow-black/5 shadow-xl">
              <CardHeader>
                <CardTitle>Current subscription</CardTitle>
                <CardDescription>
                  Stripe is the source of truth for subscription billing; the
                  app mirrors that state here.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {activeSubscription ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge>{activeSubscription.plan}</Badge>
                      <Badge variant="outline">
                        {activeSubscription.billingInterval === "year"
                          ? "Annual"
                          : "Monthly"}
                      </Badge>
                      <Badge variant="outline">
                        {activeSubscription.status}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground">
                      {activeSubscription.cancelAtPeriodEnd
                        ? `Cancels on ${formatBillingDate(activeSubscription.periodEnd) ?? "the end of the current period"}.`
                        : `Current period ends ${formatBillingDate(activeSubscription.periodEnd) ?? "soon"}.`}
                    </div>
                  </>
                ) : latestSubscription ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{latestSubscription.plan}</Badge>
                      <Badge variant="outline">
                        {latestSubscription.status}
                      </Badge>
                    </div>
                    <div className="text-muted-foreground">
                      No active subscription right now. Last recorded billing
                      period ended{" "}
                      {formatBillingDate(latestSubscription.periodEnd) ??
                        "recently"}
                      .
                    </div>
                  </>
                ) : (
                  <div className="text-muted-foreground">
                    No subscription yet. Pick a plan above to start one.
                  </div>
                )}
              </CardContent>
            </Card>
          </section>

          <aside className="space-y-6">
            <Card className="border-border/60 bg-card/95 shadow-black/5 shadow-xl">
              <CardHeader>
                <CardTitle>Credit top-up</CardTitle>
                <CardDescription>
                  Add credits without moving to another recurring tier.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="rounded-3xl border border-border/60 bg-muted/30 px-4 py-3 text-sm">
                  <div className="text-[11px] text-muted-foreground uppercase tracking-[0.22em]">
                    Pack pricing
                  </div>
                  <div className="mt-1 font-medium">
                    {formatUsd(CREDIT_TOP_UP_PACK_PRICE_CENTS)} for{" "}
                    {CREDIT_TOP_UP_PACK_SIZE.toLocaleString()} credits
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="font-medium text-sm">How many packs?</div>
                  <Input
                    max={100}
                    min={1}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      setTopUpPacks(normalizeTopUpPacks(nextValue));
                    }}
                    step={1}
                    type="number"
                    value={topUpPacks}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3 rounded-3xl border border-border/60 bg-background/70 p-4 text-sm">
                  <div>
                    <div className="text-[11px] text-muted-foreground uppercase tracking-[0.22em]">
                      Credits
                    </div>
                    <div className="mt-1 font-medium">
                      {(topUpPacks * CREDIT_TOP_UP_PACK_SIZE).toLocaleString()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-muted-foreground uppercase tracking-[0.22em]">
                      Charge
                    </div>
                    <div className="mt-1 font-medium">
                      {formatUsd(topUpPacks * CREDIT_TOP_UP_PACK_PRICE_CENTS)}
                    </div>
                  </div>
                </div>

                <Button
                  className="w-full"
                  disabled={topUpMutation.isPending}
                  onClick={() =>
                    topUpMutation.mutate(
                      { packs: topUpPacks },
                      {
                        onError: (error) => {
                          setErrorMessage(error.message);
                        },
                      },
                    )
                  }
                  type="button"
                >
                  {topUpMutation.isPending ? "Redirecting..." : "Buy top-up"}
                </Button>
              </CardContent>
            </Card>

            <Card className="border-border/60 bg-card/95 shadow-black/5 shadow-xl">
              <CardHeader>
                <CardTitle>Stripe customer portal</CardTitle>
                <CardDescription>
                  Update payment methods, invoices, and cancellation settings in
                  Stripe’s hosted portal.
                </CardDescription>
              </CardHeader>
              <CardFooter className="flex flex-col gap-3">
                <Button
                  className="w-full"
                  disabled={
                    billingPortalMutation.isPending ||
                    !overviewQuery.data?.stripeCustomerId
                  }
                  onClick={() =>
                    billingPortalMutation.mutate(undefined, {
                      onError: (error) => {
                        setErrorMessage(error.message);
                      },
                    })
                  }
                  type="button"
                  variant="outline"
                >
                  {billingPortalMutation.isPending
                    ? "Redirecting..."
                    : "Open billing portal"}
                </Button>
                <Button
                  onClick={() => void refreshOverview()}
                  type="button"
                  variant="ghost"
                >
                  Refresh billing state
                </Button>
              </CardFooter>
            </Card>

            {selectedIntent === "subscribe" && selectedPlanName ? (
              <Card className="border-primary/40 bg-primary/8">
                <CardContent className="py-4 text-sm">
                  Preparing Stripe Checkout for {selectedPlanName} on the
                  {selectedAnnual ? " annual" : " monthly"} cadence.
                </CardContent>
              </Card>
            ) : null}
          </aside>
        </div>
      </div>
    </main>
  );
}
