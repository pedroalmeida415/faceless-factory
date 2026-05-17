"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { httpLink, httpSubscriptionLink, loggerLink, splitLink } from "@trpc/client";
import { createTRPCQueryUtils, createTRPCReact } from "@trpc/react-query";
import { useMemo } from "react";
import SuperJSON from "superjson";
import { createQueryClient } from "~/main/trpc/query-client";
import type { AppRouter } from "~/main/trpc/routers";

// ============================================================================
// Mock TRPC Provider for Storybook
// ============================================================================

export const api = createTRPCReact<AppRouter>();

const createMockTrpcClient = () =>
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
  });

const mockQueryClient = createQueryClient();
const mockTrpcClient = createMockTrpcClient();

export const getTrpcClient = () => mockTrpcClient;

export const getAppTrpcQueryUtils = () =>
  createTRPCQueryUtils({
    client: mockTrpcClient,
    queryClient: mockQueryClient,
  });

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
 *             result: { data: { graph: {...}, name: "string", workflowId: "string" } }
 *           });
 *         }),
 *       ],
 *     },
 *   },
 * };
 * ```
 */
export function TRPCReactProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useMemo(() => mockQueryClient, []);
  const trpcClient = useMemo(() => mockTrpcClient, []);

  return (
    <QueryClientProvider client={queryClient}>
      <api.Provider client={trpcClient} queryClient={queryClient}>
        {children}
      </api.Provider>
    </QueryClientProvider>
  );
}
