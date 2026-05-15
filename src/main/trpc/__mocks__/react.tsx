"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpLink, httpSubscriptionLink, loggerLink, splitLink } from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { useMemo } from "react";
import SuperJSON from "superjson";
import type { AppRouter } from "~/main/trpc/routers";

// ============================================================================
// Mock TRPC Provider for Storybook
// ============================================================================

export const api = createTRPCReact<AppRouter>();

/**
 * Mock TRPC provider for Storybook stories.
 *
 * Uses httpLink (not batch) so each procedure is a separate request.
 * MSW intercepts these requests at `/api/trpc/{procedure}`.
 *
 * @example
 * ```tsx
 * // In your story
 * export const MyStory: Story = {
 *   parameters: {
 *     msw: {
 *       handlers: [
 *         http.get('/api/trpc/workflow.getWorkflow', () => {
 *           return HttpResponse.json({
 *             result: { data: { evaluation: [...], graph: {...}, name: "string", workflowId: "string" } }
 *           });
 *         }),
 *       ],
 *     },
 *   },
 * };
 * ```
 */
export function TRPCReactProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
          mutations: { retry: false },
        },
      }),
    [],
  );

  const trpcClient = useMemo(
    () =>
      api.createClient({
        links: [
          loggerLink({
            enabled: () => true,
          }),
          splitLink({
            // Route subscriptions through SSE link (MSW can intercept these)
            condition: (op) => op.type === "subscription",
            true: httpSubscriptionLink({
              url: "/api/trpc",
              transformer: SuperJSON,
            }),
            // Queries/mutations use simple httpLink (MSW intercepts at /api/trpc/{procedure})
            false: httpLink({
              url: "/api/trpc",
              transformer: SuperJSON,
            }),
          }),
        ],
      }),
    [],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <api.Provider client={trpcClient} queryClient={queryClient}>
        {children}
      </api.Provider>
    </QueryClientProvider>
  );
}
