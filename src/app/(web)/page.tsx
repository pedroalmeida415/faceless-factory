"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
import { Switch } from "~/components/ui/switch";
import { authClient } from "~/features/auth/client/client";
import {
  BILLING_PLANS,
  type BillingPlanName,
  formatUsd,
} from "~/features/billing/billing";

function getSubscriptionIntentUrl(plan: BillingPlanName, annual: boolean) {
  const searchParams = new URLSearchParams({
    annual: annual ? "1" : "0",
    intent: "subscribe",
    plan,
  });

  return `/app/billing?${searchParams.toString()}`;
}

export default function Page() {
  const router = useRouter();
  const { data: session, isPending: isSessionPending } =
    authClient.useSession();

  const [annual, setAnnual] = useState(true);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [selectedPlan, setSelectedPlan] = useState<BillingPlanName>("plus");

  const selectedPlanDetails =
    BILLING_PLANS.find((plan) => plan.name === selectedPlan) ??
    BILLING_PLANS[1];
  const callbackURL = getSubscriptionIntentUrl(selectedPlan, annual);

  async function handleGithubSignIn() {
    setErrorMessage(null);
    setIsSubmitting(true);

    const result = await authClient.signIn.social({
      callbackURL,
      provider: "github",
    });

    if (result.error) {
      setErrorMessage(result.error.message ?? "GitHub sign-in failed.");
      setIsSubmitting(false);
    }
  }

  async function handleEmailAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    const result =
      authMode === "signup"
        ? await authClient.signUp.email({
            callbackURL,
            email,
            name,
            password,
          })
        : await authClient.signIn.email({
            callbackURL,
            email,
            password,
          });

    if (result.error) {
      setErrorMessage(result.error.message ?? "Authentication failed.");
      setIsSubmitting(false);
    }
  }

  async function handleSignOut() {
    setErrorMessage(null);
    await authClient.signOut();
  }

  if (isSessionPending) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="text-muted-foreground text-sm">Checking session...</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-background px-6 py-10">
      <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1.65fr_0.95fr]">
        <section className="space-y-6">
          <div className="flex flex-col gap-4 rounded-[32px] border border-border/60 bg-card/95 p-6 shadow-2xl shadow-black/10">
            <div className="space-y-3">
              <Badge variant="outline">
                Stripe billing + monthly credit grants
              </Badge>
              <div className="space-y-2">
                <h1 className="font-semibold text-3xl tracking-tight sm:text-4xl">
                  Pick a plan, create an account, and land straight in checkout.
                </h1>
                <p className="max-w-3xl text-muted-foreground text-sm sm:text-base">
                  Annual plans bill yearly at a discount, but still unlock their
                  credits on a monthly cadence. Top-ups stay available whenever
                  you need more capacity without changing tiers.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span
                className={
                  !annual ? "text-foreground" : "text-muted-foreground"
                }
              >
                Monthly billing
              </span>
              <Switch checked={annual} onCheckedChange={setAnnual} />
              <span
                className={annual ? "text-foreground" : "text-muted-foreground"}
              >
                Annual billing
              </span>
              <Badge variant="outline">Top-up: $10 / 1,000 credits</Badge>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            {BILLING_PLANS.map((plan) => {
              const monthlyEquivalent = annual
                ? Math.round(plan.annualPriceCents / 12)
                : plan.monthlyPriceCents;

              return (
                <Card
                  className={[
                    "border-border/60 bg-card/95 shadow-black/5 shadow-xl transition-colors",
                    plan.featured ? "border-primary/50" : "",
                    selectedPlan === plan.name ? "ring-2 ring-primary" : "",
                  ].join(" ")}
                  key={plan.name}
                >
                  <CardHeader className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle>{plan.title}</CardTitle>
                      {plan.featured ? <Badge>Most popular</Badge> : null}
                    </div>
                    <CardDescription>{plan.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4 text-sm">
                    <div className="space-y-1">
                      <div className="font-semibold text-3xl tracking-tight">
                        {formatUsd(monthlyEquivalent)}
                        <span className="font-medium text-muted-foreground text-sm">
                          /mo
                        </span>
                      </div>
                      <div className="text-muted-foreground">
                        {annual
                          ? `Billed ${formatUsd(plan.annualPriceCents)} yearly`
                          : "Billed monthly"}
                      </div>
                    </div>

                    <div className="rounded-3xl border border-border/60 bg-muted/30 px-4 py-3">
                      <div className="text-[11px] text-muted-foreground uppercase tracking-[0.22em]">
                        Included credits
                      </div>
                      <div className="mt-1 font-semibold text-lg">
                        {plan.creditsPerMonth.toLocaleString()} / month
                      </div>
                    </div>
                  </CardContent>
                  <CardFooter>
                    <Button
                      className="w-full"
                      onClick={() => {
                        setSelectedPlan(plan.name);

                        if (session?.user) {
                          router.push(
                            getSubscriptionIntentUrl(plan.name, annual),
                          );
                        }
                      }}
                      type="button"
                      variant={
                        selectedPlan === plan.name ? "default" : "outline"
                      }
                    >
                      {session?.user
                        ? `Choose ${plan.title}`
                        : selectedPlan === plan.name
                          ? `Selected ${plan.title}`
                          : `Select ${plan.title}`}
                    </Button>
                  </CardFooter>
                </Card>
              );
            })}
          </div>
        </section>

        <aside>
          {session?.user ? (
            <Card className="border border-border/60 bg-card/95 shadow-2xl shadow-black/10">
              <CardHeader>
                <CardTitle>Welcome back</CardTitle>
                <CardDescription>
                  Signed in as {session.user.email}. Jump into the app or manage
                  billing for your selected plan.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-muted-foreground text-sm">
                <p>{session.user.name ?? "Unnamed user"}</p>
                <p>
                  Current checkout target: {selectedPlanDetails.title},{" "}
                  {annual ? "annual" : "monthly"}.
                </p>
              </CardContent>
              <CardFooter className="flex flex-col gap-3 sm:flex-row">
                <Button asChild className="w-full sm:flex-1">
                  <Link href="/app">Open app</Link>
                </Button>
                <Button
                  className="w-full sm:flex-1"
                  onClick={() => router.push(callbackURL)}
                  type="button"
                  variant="outline"
                >
                  Manage billing
                </Button>
                <Button
                  onClick={() => {
                    void handleSignOut();
                  }}
                  type="button"
                  variant="ghost"
                >
                  Sign out
                </Button>
              </CardFooter>
            </Card>
          ) : (
            <Card className="border border-border/60 bg-card/95 shadow-2xl shadow-black/10">
              <CardHeader>
                <CardTitle>
                  {authMode === "signup" ? "Create your account" : "Sign in"}
                </CardTitle>
                <CardDescription>
                  {authMode === "signup"
                    ? `After account creation you will continue to Stripe Checkout for ${selectedPlanDetails.title}.`
                    : `Sign in and continue to the ${selectedPlanDetails.title} checkout flow.`}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    onClick={() => setAuthMode("signup")}
                    type="button"
                    variant={authMode === "signup" ? "default" : "outline"}
                  >
                    Sign up
                  </Button>
                  <Button
                    className="flex-1"
                    onClick={() => setAuthMode("signin")}
                    type="button"
                    variant={authMode === "signin" ? "default" : "outline"}
                  >
                    Sign in
                  </Button>
                </div>

                <div className="rounded-3xl border border-border/60 bg-muted/30 px-4 py-3 text-sm">
                  <div className="text-[11px] text-muted-foreground uppercase tracking-[0.22em]">
                    Selected plan
                  </div>
                  <div className="mt-1 font-medium">
                    {selectedPlanDetails.title} ·{" "}
                    {annual ? "Annual" : "Monthly"}
                  </div>
                  <div className="text-muted-foreground">
                    {selectedPlanDetails.creditsPerMonth.toLocaleString()}{" "}
                    credits per month
                  </div>
                </div>

                <form
                  className="space-y-3"
                  onSubmit={(event) => void handleEmailAuth(event)}
                >
                  {authMode === "signup" ? (
                    <Input
                      autoComplete="name"
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Full name"
                      required
                      value={name}
                    />
                  ) : null}
                  <Input
                    autoComplete="email"
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="Email"
                    required
                    type="email"
                    value={email}
                  />
                  <Input
                    autoComplete={
                      authMode === "signup"
                        ? "new-password"
                        : "current-password"
                    }
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="Password"
                    required
                    type="password"
                    value={password}
                  />

                  {errorMessage ? (
                    <p className="text-destructive text-sm">{errorMessage}</p>
                  ) : null}

                  <Button
                    className="w-full"
                    disabled={isSubmitting}
                    type="submit"
                  >
                    {isSubmitting
                      ? "Redirecting..."
                      : authMode === "signup"
                        ? "Continue with email"
                        : "Sign in with email"}
                  </Button>
                </form>

                <div className="text-center text-muted-foreground text-xs uppercase tracking-[0.24em]">
                  or
                </div>

                <Button
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => {
                    void handleGithubSignIn();
                  }}
                  type="button"
                  variant="outline"
                >
                  {isSubmitting ? "Redirecting..." : "Continue with GitHub"}
                </Button>
              </CardContent>
            </Card>
          )}
        </aside>
      </div>
    </main>
  );
}
