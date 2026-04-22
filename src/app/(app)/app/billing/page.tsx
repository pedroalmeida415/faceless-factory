"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

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
  type BillingPlanId,
  CREDIT_TOP_UP,
  isBillingPlanId,
} from "~/lib/billing/plans";
import { authClient } from "~/server/better-auth/client";
import { api } from "~/trpc/react";

function parseAnnualFlag(value: string | null) {
  return value === "1" || value === "true";
}

function clampTopUpQuantity(quantity: number) {
  if (!Number.isFinite(quantity)) {
    return CREDIT_TOP_UP.minQuantity;
  }

  return Math.min(
    CREDIT_TOP_UP.maxQuantity,
    Math.max(CREDIT_TOP_UP.minQuantity, Math.floor(quantity)),
  );
}

export default function BillingPage() {
  const searchParams = useSearchParams();
  const currentSubscriptionQuery = api.billing.currentSubscription.useQuery();
  const topUpCheckoutMutation = api.billing.createTopUpCheckout.useMutation();

  const [activeCheckoutPlan, setActiveCheckoutPlan] =
    useState<BillingPlanId | null>(null);
  const [hasAutoCheckoutStarted, setHasAutoCheckoutStarted] = useState(false);
  const [isAnnualBilling, setIsAnnualBilling] = useState(
    parseAnnualFlag(searchParams.get("annual")),
  );
  const [isBillingPortalPending, setIsBillingPortalPending] = useState(false);
  const [topUpQuantity, setTopUpQuantity] = useState<number>(
    CREDIT_TOP_UP.minQuantity,
  );
  const [billingError, setBillingError] = useState<string | null>(null);

  const activeSubscription = currentSubscriptionQuery.data;
  const activePlan = isBillingPlanId(activeSubscription?.plan)
    ? activeSubscription.plan
    : null;
  const activeInterval = activeSubscription?.billingInterval ?? "month";
  const isCheckoutPending = activeCheckoutPlan !== null;
  const selectedBillingInterval = isAnnualBilling ? "year" : "month";
  const checkoutStatus = searchParams.get("checkout");
  const topUpStatus = searchParams.get("topup");

  const startSubscriptionCheckout = useCallback(
    async (planId: BillingPlanId, annual: boolean) => {
      setBillingError(null);
      setActiveCheckoutPlan(planId);

      const result = await authClient.subscription.upgrade({
        annual,
        cancelUrl: "/app/billing?checkout=cancel",
        plan: planId,
        returnUrl: "/app/billing",
        subscriptionId: activeSubscription?.stripeSubscriptionId ?? undefined,
        successUrl: "/app/billing?checkout=success",
      });

      if (result.error) {
        setBillingError(
          result.error.message ?? "Unable to open Stripe checkout.",
        );
      }

      setActiveCheckoutPlan(null);
    },
    [activeSubscription?.stripeSubscriptionId],
  );

  useEffect(() => {
    setIsAnnualBilling(parseAnnualFlag(searchParams.get("annual")));
  }, [searchParams]);

  useEffect(() => {
    const shouldAutoCheckout = searchParams.get("autoCheckout") === "1";
    const requestedPlan = searchParams.get("plan");

    if (
      !shouldAutoCheckout ||
      hasAutoCheckoutStarted ||
      currentSubscriptionQuery.isLoading ||
      activeSubscription ||
      !isBillingPlanId(requestedPlan)
    ) {
      return;
    }

    setHasAutoCheckoutStarted(true);
    void startSubscriptionCheckout(
      requestedPlan,
      parseAnnualFlag(searchParams.get("annual")),
    );
  }, [
    activeSubscription,
    currentSubscriptionQuery.isLoading,
    hasAutoCheckoutStarted,
    searchParams,
    startSubscriptionCheckout,
  ]);

  const openBillingPortal = async () => {
    setBillingError(null);
    setIsBillingPortalPending(true);

    const result = await authClient.subscription.billingPortal({
      returnUrl: "/app/billing",
    });

    if (result.error) {
      setBillingError(result.error.message ?? "Unable to open billing portal.");
    }

    setIsBillingPortalPending(false);
  };

  const startTopUpCheckout = async () => {
    setBillingError(null);

    try {
      const data = await topUpCheckoutMutation.mutateAsync({
        quantity: topUpQuantity,
      });
      window.location.assign(data.url);
    } catch (error) {
      const fallback = "Unable to start credit top-up checkout.";
      setBillingError(error instanceof Error ? error.message : fallback);
    }
  };

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-8 md:px-6">
      <Card className="border-border/60 bg-card/95">
        <CardHeader className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-2">
            <CardTitle>Billing & credits</CardTitle>
            <CardDescription>
              Pick a plan, switch billing interval, or purchase one-time credit
              top-ups.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setIsAnnualBilling(false)}
              size="sm"
              type="button"
              variant={isAnnualBilling ? "outline" : "default"}
            >
              Monthly
            </Button>
            <Button
              onClick={() => setIsAnnualBilling(true)}
              size="sm"
              type="button"
              variant={isAnnualBilling ? "default" : "outline"}
            >
              Annual
            </Button>
          </div>
        </CardHeader>
      </Card>

      {checkoutStatus === "success" ? (
        <p className="text-emerald-400 text-sm">
          Subscription checkout completed. Stripe may take a few seconds to sync
          the latest status.
        </p>
      ) : null}
      {checkoutStatus === "cancel" ? (
        <p className="text-muted-foreground text-sm">
          Subscription checkout was cancelled.
        </p>
      ) : null}
      {topUpStatus === "success" ? (
        <p className="text-emerald-400 text-sm">
          Top-up payment completed. Credits are added when Stripe confirms the
          webhook.
        </p>
      ) : null}
      {topUpStatus === "cancel" ? (
        <p className="text-muted-foreground text-sm">
          Top-up checkout was cancelled.
        </p>
      ) : null}
      {billingError ? (
        <p className="text-destructive text-sm">{billingError}</p>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-3">
        {BILLING_PLANS.map((plan) => {
          const planPrice = plan.pricingUsd[selectedBillingInterval];
          const isCurrentPlan =
            activePlan === plan.id &&
            activeInterval === selectedBillingInterval;

          return (
            <Card className="border-border/60 bg-card/95" key={plan.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between">
                  <span>{plan.name}</span>
                  {isCurrentPlan ? (
                    <span className="text-emerald-400 text-xs">Current</span>
                  ) : null}
                </CardTitle>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-muted-foreground text-sm">
                <p className="font-semibold text-2xl text-foreground">
                  ${planPrice}
                  <span className="ml-1 font-normal text-muted-foreground text-sm">
                    /month
                  </span>
                </p>
                <p>
                  {isAnnualBilling
                    ? "Billed annually"
                    : "Billed month to month"}
                </p>
                <p>{plan.creditsPerMonth.toLocaleString()} credits per month</p>
              </CardContent>
              <CardFooter>
                <Button
                  className="w-full"
                  disabled={isCheckoutPending || isCurrentPlan}
                  onClick={() => {
                    void startSubscriptionCheckout(plan.id, isAnnualBilling);
                  }}
                  type="button"
                  variant={isCurrentPlan ? "outline" : "default"}
                >
                  {activeCheckoutPlan === plan.id
                    ? "Redirecting..."
                    : isCurrentPlan
                      ? "Current plan"
                      : activeSubscription
                        ? `Switch to ${plan.name}`
                        : `Choose ${plan.name}`}
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </section>

      <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <Card className="border-border/60 bg-card/95">
          <CardHeader>
            <CardTitle>Credit top-up</CardTitle>
            <CardDescription>
              ${CREDIT_TOP_UP.unitAmountUsd} for{" "}
              {CREDIT_TOP_UP.credits.toLocaleString()} credits.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-muted-foreground text-sm">
            <label className="block space-y-1" htmlFor="top-up-quantity-input">
              <span>Quantity</span>
              <Input
                id="top-up-quantity-input"
                max={CREDIT_TOP_UP.maxQuantity}
                min={CREDIT_TOP_UP.minQuantity}
                onChange={(event) =>
                  setTopUpQuantity(
                    clampTopUpQuantity(Number(event.currentTarget.value)),
                  )
                }
                type="number"
                value={topUpQuantity}
              />
            </label>
            <p>
              You will purchase{" "}
              {(topUpQuantity * CREDIT_TOP_UP.credits).toLocaleString()} credits
              for ${topUpQuantity * CREDIT_TOP_UP.unitAmountUsd}.
            </p>
          </CardContent>
          <CardFooter>
            <Button
              className="w-full"
              disabled={topUpCheckoutMutation.isPending}
              onClick={() => {
                void startTopUpCheckout();
              }}
              type="button"
            >
              {topUpCheckoutMutation.isPending
                ? "Redirecting..."
                : "Buy credits"}
            </Button>
          </CardFooter>
        </Card>

        <Card className="border-border/60 bg-card/95">
          <CardHeader>
            <CardTitle>Manage billing</CardTitle>
            <CardDescription>
              Update payment methods and invoices in Stripe Customer Portal.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-muted-foreground text-sm">
            <p>
              Active plan:{" "}
              {activePlan ? `${activePlan} (${activeInterval})` : "none"}
            </p>
          </CardContent>
          <CardFooter className="flex flex-col gap-2">
            <Button
              className="w-full"
              disabled={isBillingPortalPending || !activeSubscription}
              onClick={() => {
                void openBillingPortal();
              }}
              type="button"
              variant="outline"
            >
              {isBillingPortalPending ? "Opening..." : "Open billing portal"}
            </Button>
            <Button asChild className="w-full" variant="ghost">
              <Link href="/app">Back to studio</Link>
            </Button>
          </CardFooter>
        </Card>
      </section>
    </main>
  );
}
