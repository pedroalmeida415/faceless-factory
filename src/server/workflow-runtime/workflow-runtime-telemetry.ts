import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Context, Effect, Layer, Metric } from "effect";

export type WorkflowRuntimeTelemetryConfig = {
  readonly enabled: boolean;
  readonly exporterEndpoint: string | null;
  readonly serviceName: string;
};

export type WorkflowRuntimePostCommitDeliveryTelemetry = {
  readonly attempt: number;
  readonly cause: string;
  readonly itemIndex?: number;
  readonly jobId?: string;
  readonly kind: "execution-job" | "task-status-event" | "wake-up-call-job";
  readonly nodeExecutionId?: string;
  readonly source: string;
  readonly status?: string;
  readonly taskRunId?: string;
  readonly workflowId: string;
};

export const workflowRuntimeTelemetryMetrics = {
  postCommitAttemptFailures: Metric.counter(
    "workflow_runtime_post_commit_delivery_attempt_failures_total",
    {
      description:
        "Failed Workflow Runtime Post-Commit Work delivery attempts.",
      incremental: true,
    },
  ),
  postCommitExhaustedFailures: Metric.counter(
    "workflow_runtime_post_commit_delivery_exhausted_failures_total",
    {
      description:
        "Workflow Runtime Post-Commit Work items exhausted by retry.",
      incremental: true,
    },
  ),
} as const;

type PostCommitCounter =
  (typeof workflowRuntimeTelemetryMetrics)[keyof typeof workflowRuntimeTelemetryMetrics];

export class WorkflowRuntimeTelemetry extends Context.Tag(
  "WorkflowRuntimeTelemetry",
)<
  WorkflowRuntimeTelemetry,
  {
    readonly config: WorkflowRuntimeTelemetryConfig;
    readonly postCommitDeliveryAttemptFailed: (
      details: WorkflowRuntimePostCommitDeliveryTelemetry,
    ) => Effect.Effect<void>;
    readonly postCommitDeliveryExhausted: (
      details: WorkflowRuntimePostCommitDeliveryTelemetry,
    ) => Effect.Effect<void>;
  }
>() {
  static readonly fromEnv = (
    env: Partial<NodeJS.ProcessEnv> = process.env,
  ): WorkflowRuntimeTelemetryConfig => {
    const explicit = env.WORKFLOW_RUNTIME_OTEL_ENABLED;
    const exporterEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null;
    const enabled =
      explicit === "true" &&
      exporterEndpoint !== null &&
      env.NODE_ENV !== "test" &&
      env.CI !== "true";

    return {
      enabled,
      exporterEndpoint: enabled ? exporterEndpoint : null,
      serviceName: env.OTEL_SERVICE_NAME ?? "faceless-factory-workflow-runtime",
    };
  };

  static readonly setupLayer = (config: WorkflowRuntimeTelemetryConfig) => {
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

  static readonly layerFromConfig = (config: WorkflowRuntimeTelemetryConfig) =>
    Layer.mergeAll(
      Layer.succeed(WorkflowRuntimeTelemetry, {
        config,
        postCommitDeliveryAttemptFailed: (details) =>
          Metric.increment(
            tagPostCommitMetric(
              workflowRuntimeTelemetryMetrics.postCommitAttemptFailures,
              details,
            ),
          ).pipe(
            Effect.zipRight(
              Effect.logDebug(
                "Workflow Runtime Post-Commit Work delivery attempt failed",
                details,
              ),
            ),
          ),
        postCommitDeliveryExhausted: (details) =>
          Metric.increment(
            tagPostCommitMetric(
              workflowRuntimeTelemetryMetrics.postCommitExhaustedFailures,
              details,
            ),
          ).pipe(
            Effect.zipRight(
              Effect.logWarning(
                "Workflow Runtime Post-Commit Work delivery exhausted",
                details,
              ),
            ),
          ),
      }),
      WorkflowRuntimeTelemetry.setupLayer(config),
    );

  static readonly Local = WorkflowRuntimeTelemetry.layerFromConfig(
    WorkflowRuntimeTelemetry.fromEnv({}),
  );

  static readonly Live = WorkflowRuntimeTelemetry.layerFromConfig(
    WorkflowRuntimeTelemetry.fromEnv(),
  );
}

function tagPostCommitMetric(
  metric: PostCommitCounter,
  details: WorkflowRuntimePostCommitDeliveryTelemetry,
) {
  return metric.pipe(
    Metric.tagged("work_kind", details.kind),
    Metric.tagged("source", details.source),
    Metric.tagged("workflow_id", details.workflowId),
    Metric.tagged("task_run_id", details.taskRunId ?? "none"),
    Metric.tagged("status", details.status ?? "none"),
  );
}
