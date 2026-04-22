"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  BILLING_PLANS,
  type BillingPlanId,
  CREDIT_TOP_UP,
} from "~/lib/billing/plans";
import { authClient } from "~/server/better-auth/client";

export default function Page() {
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();

  const [isAnnualBilling, setIsAnnualBilling] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<
    BillingPlanId | "generic" | null
  >(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleGithubSignIn = async (
    callbackURL: string,
    pendingValue: BillingPlanId | "generic",
  ) => {
    setErrorMessage(null);
    setPendingPlan(pendingValue);

    const result = await authClient.signIn.social({
      callbackURL,
      provider: "github",
    });

    if (result.error) {
      setErrorMessage(result.error.message ?? "GitHub sign-in failed.");
      setPendingPlan(null);
    }
  };

  const handlePlanSignIn = (planId: BillingPlanId) => {
    const params = new URLSearchParams({
      annual: isAnnualBilling ? "1" : "0",
      autoCheckout: "1",
      plan: planId,
    });

    void handleGithubSignIn(`/app/billing?${params.toString()}`, planId);
  };

  const handleSignOut = async () => {
    setErrorMessage(null);
    await authClient.signOut();
  };

  if (isSessionPending) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="text-sm text-muted-foreground">Checking session...</div>
      </main>
    );
  }

  if (session?.user) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6">
        <Card className="w-full max-w-md border border-border/60 bg-card/95">
          <CardHeader>
            <CardTitle>Welcome back</CardTitle>
            <CardDescription>
              You are signed in as {session.user.email}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            <p>{session.user.name ?? "Unnamed user"}</p>
            <p>Open the workflow studio or manage your Stripe billing.</p>
          </CardContent>
          <CardFooter className="flex flex-col gap-2 sm:flex-row">
            <Button asChild className="w-full">
              <Link href="/app">Open app</Link>
            </Button>
            <Button asChild className="w-full" variant="outline">
              <Link href="/app/billing">Manage billing</Link>
            </Button>
            <Button
              className="w-full sm:w-auto"
              onClick={() => {
                void handleSignOut();
              }}
              variant="ghost"
            >
              Sign out
            </Button>
          </CardFooter>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-6 py-10">
      <Card className="border border-border/60 bg-card/95 shadow-2xl shadow-black/20">
        <CardHeader>
          <CardTitle>Faceless Factory plans</CardTitle>
          <CardDescription>
            Sign in with GitHub, then Stripe checkout will continue with the
            plan you selected.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <p>
            Top-ups stay available across plan changes ($
            {CREDIT_TOP_UP.unitAmountUsd} /{" "}
            {CREDIT_TOP_UP.credits.toLocaleString()} credits).
          </p>
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
        </CardContent>
      </Card>

      {errorMessage ? (
        <p className="text-sm text-destructive">{errorMessage}</p>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3">
        {BILLING_PLANS.map((plan) => {
          const planPrice = plan.pricingUsd[isAnnualBilling ? "year" : "month"];
          const isPlanPending = pendingPlan === plan.id;

          return (
            <Card className="border border-border/60 bg-card/95" key={plan.id}>
              <CardHeader>
                <CardTitle>{plan.name}</CardTitle>
                <CardDescription>{plan.description}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-muted-foreground">
                <p className="text-2xl font-semibold text-foreground">
                  ${planPrice}
                  <span className="ml-1 text-sm font-normal text-muted-foreground">
                    /month
                  </span>
                </p>
                <p>
                  {isAnnualBilling
                    ? "Billed annually"
                    : "Billed month to month"}
                </p>
                <p>
                  {plan.creditsPerMonth.toLocaleString()} credits included
                  monthly
                </p>
              </CardContent>
              <CardFooter>
                <Button
                  className="w-full"
                  disabled={pendingPlan !== null}
                  onClick={() => handlePlanSignIn(plan.id)}
                  type="button"
                >
                  {isPlanPending
                    ? "Redirecting..."
                    : `Continue with ${plan.name}`}
                </Button>
              </CardFooter>
            </Card>
          );
        })}
      </section>

      <div className="flex justify-center">
        <Button
          disabled={pendingPlan !== null}
          onClick={() => {
            void handleGithubSignIn("/app", "generic");
          }}
          type="button"
          variant="ghost"
        >
          {pendingPlan === "generic"
            ? "Redirecting..."
            : "Continue with GitHub and choose later"}
        </Button>
      </div>
    </main>
  );
}
