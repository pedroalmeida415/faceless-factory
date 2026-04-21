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
import { authClient } from "~/server/better-auth/client";

export default function Page() {
  const { data: session, isPending: isSessionPending } = authClient.useSession();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleGithubSignIn = async () => {
    setErrorMessage(null);
    setIsSubmitting(true);

    const result = await authClient.signIn.social({
      provider: "github",
      callbackURL: "/app",
    });

    if (result.error) {
      setErrorMessage(result.error.message ?? "GitHub sign-in failed.");
      setIsSubmitting(false);
    }
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
            <p>The `/app` route is now protected and ready to use.</p>
          </CardContent>
          <CardFooter className="gap-3">
            <Button asChild className="flex-1">
              <Link href="/app">Open app</Link>
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                void handleSignOut();
              }}
            >
              Sign out
            </Button>
          </CardFooter>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-md border border-border/60 bg-card/95 shadow-2xl shadow-black/20">
        <CardHeader>
          <CardTitle>Faceless Factory</CardTitle>
          <CardDescription>
            Continue with GitHub to open the protected workflow studio.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            The `/app` route redirects back here unless an authenticated session
            is present.
          </p>
          {errorMessage ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
          ) : null}
          <Button
            className="w-full"
            disabled={isSubmitting}
            onClick={() => {
              void handleGithubSignIn();
            }}
            type="button"
            variant="default"
          >
            {isSubmitting ? "Redirecting..." : "Continue with GitHub"}
          </Button>
        </CardContent>
        <CardFooter className="text-sm text-muted-foreground">
          GitHub is the only enabled sign-in method right now.
        </CardFooter>
      </Card>
    </main>
  );
}
