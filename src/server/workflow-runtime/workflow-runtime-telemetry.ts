import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Context, Layer } from "effect";

export type WorkflowRuntimeTelemetryConfig = {
  readonly enabled: boolean;
  readonly exporterEndpoint: string | null;
  readonly serviceName: string;
};

export class WorkflowRuntimeTelemetry extends Context.Tag(
  "WorkflowRuntimeTelemetry",
)<
  WorkflowRuntimeTelemetry,
  {
    readonly config: WorkflowRuntimeTelemetryConfig;
  }
>() {
  static readonly fromEnv = (
    env: NodeJS.ProcessEnv = process.env,
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
          new OTLPTraceExporter({ url: config.exporterEndpoint }),
        ),
      ],
    }));
  };

  static readonly layerFromConfig = (config: WorkflowRuntimeTelemetryConfig) =>
    Layer.mergeAll(
      Layer.succeed(WorkflowRuntimeTelemetry, { config }),
      WorkflowRuntimeTelemetry.setupLayer(config),
    );

  static readonly Local = WorkflowRuntimeTelemetry.layerFromConfig(
    WorkflowRuntimeTelemetry.fromEnv({}),
  );

  static readonly Live = WorkflowRuntimeTelemetry.layerFromConfig(
    WorkflowRuntimeTelemetry.fromEnv(),
  );
}
