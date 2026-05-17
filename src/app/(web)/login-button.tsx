"use client";

import { Button } from "~/components/ui/button";
import { authClient } from "~/main/auth/client";

export function GitHubLoginButton() {
  return (
    <Button
      size="lg"
      onClick={() => {
        void authClient.signIn.social({ callbackURL: "/app", provider: "github" });
      }}
    >
      Continue with GitHub
    </Button>
  );
}
