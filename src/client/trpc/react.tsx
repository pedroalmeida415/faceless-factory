"use client";

import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  httpBatchStreamLink,
  httpLink,
  httpSubscriptionLink,
  isNonJsonSerializable,
  loggerLink,
  splitLink,
} from "@trpc/client";
import { createTRPCQueryUtils, createTRPCReact } from "@trpc/react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { useState } from "react";
import SuperJSON from "superjson";
import { env } from "~/env";
import type { AppRouter } from "~/server/api/root";
import { createQueryClient } from "./query-client";

export const api = createTRPCReact<AppRouter>();

// Necessary factory wrapper. DO NOT CHANGE.
let clientQueryClientSingleton: QueryClient | undefined;
const getQueryClient = () => {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return createQueryClient();
  }
  // Browser: use singleton pattern to keep the same query client
  clientQueryClientSingleton ??= createQueryClient();

  return clientQueryClientSingleton;
};

const createTrpcClient = () =>
  api.createClient({
    links: (() => {
      const url = `${getBaseUrl()}/api/trpc`;
      const headers = () => {
        const nextHeaders = new Headers();
        nextHeaders.set("x-trpc-source", "nextjs-react");
        return nextHeaders;
      };

      return [
        loggerLink({
          enabled: (op) =>
            env.NEXT_PUBLIC_NODE_ENV === "development" ||
            (op.direction === "down" && op.result instanceof Error),
        }),
        splitLink({
          condition: (op) => op.type === "subscription",
          true: httpSubscriptionLink({
            transformer: SuperJSON,
            url,
          }),
          false: splitLink({
            condition: (op) => isNonJsonSerializable(op.input),
            false: httpBatchStreamLink({
              transformer: SuperJSON,
              url,
              headers,
            }),
            true: httpLink({
              transformer: {
                // request - convert data before sending to the tRPC server
                serialize: (data) => data,
                // response - convert the tRPC response before using it in client
                deserialize: (data) => SuperJSON.deserialize(data),
              },
              url,
              headers,
            }),
          }),
        }),
      ];
    })(),
  });

let clientTrpcClientSingleton: ReturnType<typeof createTrpcClient> | undefined;

export const getTrpcClient = () => {
  if (typeof window === "undefined") {
    return createTrpcClient();
  }

  clientTrpcClientSingleton ??= createTrpcClient();
  return clientTrpcClientSingleton;
};

export const getAppTrpcQueryUtils = () =>
  createTRPCQueryUtils({
    client: getTrpcClient(),
    queryClient: getQueryClient(),
  });

/**
 * Inference helper for inputs.
 *
 * @example type HelloInput = RouterInputs['example']['hello']
 */
export type RouterInputs = inferRouterInputs<AppRouter>;

/**
 * Inference helper for outputs.
 *
 * @example type HelloOutput = RouterOutputs['example']['hello']
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export function TRPCReactProvider(props: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(getTrpcClient);

  return (
    <QueryClientProvider client={queryClient}>
      <api.Provider client={trpcClient} queryClient={queryClient}>
        {props.children}
      </api.Provider>
    </QueryClientProvider>
  );
}

function getBaseUrl() {
  if (typeof window !== "undefined") return window.location.origin;
  // if (env.NEXT_PUBLIC_VERCEL_URL) return `https://${env.NEXT_PUBLIC_VERCEL_URL}`;
  return `http://localhost:${env.NEXT_PUBLIC_PORT ?? 3000}`;
}
