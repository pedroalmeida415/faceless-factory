import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { env } from "~/env";

export const OpenTelemetryLive = NodeSdk.layer(() => ({
  resource: {
    serviceName: env.OTEL_SERVICE_NAME ?? "faceless-factory",
  },
  spanProcessor: [new BatchSpanProcessor(new OTLPTraceExporter({ url: env.OTEL_EXPORTER_OTLP_ENDPOINT }))],
}));
