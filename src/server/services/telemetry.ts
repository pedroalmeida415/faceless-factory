import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Context, Effect, Layer, Metric } from "effect";

import { env } from "~/env";

export type TelemetryServiceConfig = {
  readonly enabled: boolean;
  readonly exporterEndpoint: string | null;
  readonly serviceName: string;
};

export type RuntimePostCommitDeliveryTelemetry = {
  readonly attempt: number;
  readonly cause: string;
  readonly branchIndex?: number;
  readonly jobId?: string;
  readonly kind: "execution-job" | "task-status-event" | "wake-up-call-job";
  readonly nodeRunId?: string;
  readonly source: string;
  readonly status?: string;
  readonly taskId?: string;
  readonly workflowId: string;
};

export const runtimeTelemetryMetrics = {
  postCommitAttemptFailures: Metric.counter(
    "workflow_runtime_post_commit_delivery_attempt_failures_total",
    {
      description: "Failed Runtime Post-Commit Work delivery attempts.",
      incremental: true,
    },
  ),
  postCommitExhaustedFailures: Metric.counter(
    "workflow_runtime_post_commit_delivery_exhausted_failures_total",
    {
      description: "Runtime Post-Commit Work items exhausted by retry.",
      incremental: true,
    },
  ),
} as const;

type PostCommitCounter =
  (typeof runtimeTelemetryMetrics)[keyof typeof runtimeTelemetryMetrics];

export class TelemetryService extends Context.Tag("TelemetryService")<
  TelemetryService,
  {
    readonly config: TelemetryServiceConfig;
    readonly postCommitDeliveryAttemptFailed: (
      details: RuntimePostCommitDeliveryTelemetry,
    ) => Effect.Effect<void>;
    readonly postCommitDeliveryExhausted: (
      details: RuntimePostCommitDeliveryTelemetry,
    ) => Effect.Effect<void>;
  }
>() {
  static readonly setupLayer = (config: TelemetryServiceConfig) => {
    if (!config.enabled || config.exporterEndpoint === null) {
      return Layer.empty;
    }

    return NodeSdk.layer(() => ({
      resource: {
        serviceName: config.serviceName,
      },
      spanProcessor: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({ url: config.exporterEndpoint ?? undefined }),
        ),
      ],
    }));
  };

  static readonly layerFromConfig = (config: TelemetryServiceConfig) =>
    Layer.mergeAll(
      Layer.succeed(TelemetryService, {
        config,
        postCommitDeliveryAttemptFailed: (details) =>
          Metric.increment(
            tagPostCommitMetric(
              runtimeTelemetryMetrics.postCommitAttemptFailures,
              details,
            ),
          ).pipe(
            Effect.zipRight(
              Effect.logDebug(
                "Runtime Post-Commit Work delivery attempt failed",
                details,
              ),
            ),
          ),
        postCommitDeliveryExhausted: (details) =>
          Metric.increment(
            tagPostCommitMetric(
              runtimeTelemetryMetrics.postCommitExhaustedFailures,
              details,
            ),
          ).pipe(
            Effect.zipRight(
              Effect.logWarning(
                "Runtime Post-Commit Work delivery exhausted",
                details,
              ),
            ),
          ),
      }),
      TelemetryService.setupLayer(config),
    );

  static readonly Local = TelemetryService.layerFromConfig({
    enabled: false,
    exporterEndpoint: null,
    serviceName: "faceless-factory-server",
  });

  static readonly Test = TelemetryService.Local;

  static readonly enabledByEnv = env.RUNTIME_OTEL_ENABLED === "true";

  static readonly Live = TelemetryService.layerFromConfig({
    enabled:
      TelemetryService.enabledByEnv &&
      Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT) &&
      env.NODE_ENV !== "test" &&
      env.CI !== "true",
    exporterEndpoint:
      TelemetryService.enabledByEnv &&
      Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT) &&
      env.NODE_ENV !== "test" &&
      env.CI !== "true"
        ? (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null)
        : null,
    serviceName: env.OTEL_SERVICE_NAME ?? "faceless-factory-server",
  });
}

function tagPostCommitMetric(
  metric: PostCommitCounter,
  details: RuntimePostCommitDeliveryTelemetry,
) {
  return metric.pipe(
    Metric.tagged("work_kind", details.kind),
    Metric.tagged("source", details.source),
    Metric.tagged("workflow_id", details.workflowId),
    Metric.tagged("task_id", details.taskId ?? "none"),
    Metric.tagged("status", details.status ?? "none"),
  );
}
