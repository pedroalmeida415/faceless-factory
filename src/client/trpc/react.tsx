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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function summarizeWorkflowDocument(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }

  const { edges, nodes, version } = value;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) {
    return null;
  }

  const assetCount = nodes.reduce((total, node) => {
    if (!isRecord(node)) {
      return total;
    }

    const assets = Array.isArray(node.assets) ? node.assets.length : 0;
    const outputs = Array.isArray(node.outputs) ? node.outputs.length : 0;

    return total + assets + outputs;
  }, 0);

  return {
    assetCount,
    edgeCount: edges.length,
    nodeCount: nodes.length,
    version,
  };
}

function summarizeTrpcValue(value: unknown): unknown {
  const workflowDocumentSummary = summarizeWorkflowDocument(value);
  if (workflowDocumentSummary) {
    return workflowDocumentSummary;
  }

  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
    };
  }

  if (typeof File !== "undefined" && value instanceof File) {
    return {
      lastModified: value.lastModified,
      name: value.name,
      size: value.size,
      type: value.type,
    };
  }

  if (typeof FormData !== "undefined" && value instanceof FormData) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, entryValue]) => [
        key,
        summarizeTrpcValue(entryValue),
      ]),
    );
  }

  if (Array.isArray(value)) {
    return {
      length: value.length,
      type: "array",
    };
  }

  if (typeof value === "string") {
    return `[string:${value.length}]`;
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        summarizeTrpcValue(entryValue),
      ]),
    );
  }

  return value;
}

function logTrpcOperation(props: {
  direction: "up" | "down";
  elapsedMs?: number;
  id: number;
  input: unknown;
  path: string;
  result?: unknown;
  type: "query" | "mutation" | "subscription";
}) {
  const prefix = `[trpc] ${props.direction === "up" ? ">>" : "<<"} ${props.type} #${props.id} ${props.path}`;
  const payload =
    props.direction === "up"
      ? { input: summarizeTrpcValue(props.input) }
      : {
          elapsedMs: props.elapsedMs,
          input: summarizeTrpcValue(props.input),
          result: summarizeTrpcValue(props.result),
        };

  const isError = props.direction === "down" && props.result instanceof Error;

  (isError ? console.error : console.log)(prefix, payload);
}

// Necessary factory wrapper. DO NOT CHANGE.
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
            env.NODE_ENV === "development" ||
            (op.direction === "down" && op.result instanceof Error),
          logger: (props) => {
            logTrpcOperation(props);
          },
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

// Necessary factory wrapper. DO NOT CHANGE.
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
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return `http://localhost:${env.PORT ?? 3000}`;
}
