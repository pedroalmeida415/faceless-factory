import { GitHubLoginButton } from "./login-button";

export default function HomePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <section className="max-w-xl space-y-8 text-center">
        <div className="space-y-3">
          <p className="font-medium text-primary text-sm uppercase tracking-[0.35em]">Faceless Factory</p>
          <h1 className="font-semibold text-4xl tracking-tight sm:text-6xl">Build generative media workflows.</h1>
          <p className="text-lg text-muted-foreground">Compose image and video pipelines in a node-based workspace.</p>
        </div>
        <GitHubLoginButton />
      </section>
    </main>
  );
}
