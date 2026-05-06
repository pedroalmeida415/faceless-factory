import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { WorkflowRuntimeTelemetry } from "~/server/workflow-runtime/workflow-runtime-telemetry";

describe("WorkflowRuntimeTelemetry", () => {
  test("keeps local and CI defaults disabled", () => {
    assert.deepEqual(WorkflowRuntimeTelemetry.fromEnv({}), {
      enabled: false,
      exporterEndpoint: null,
      serviceName: "faceless-factory-workflow-runtime",
    });
    assert.equal(
      WorkflowRuntimeTelemetry.fromEnv({
        CI: "true",
        NODE_ENV: "test",
        WORKFLOW_RUNTIME_OTEL_ENABLED: "true",
      }).enabled,
      false,
    );
    assert.equal(
      WorkflowRuntimeTelemetry.fromEnv({
        NODE_ENV: "production",
        WORKFLOW_RUNTIME_OTEL_ENABLED: "true",
      }).enabled,
      false,
    );
  });

  test("enables OpenTelemetry only when explicitly env-gated", () => {
    assert.deepEqual(
      WorkflowRuntimeTelemetry.fromEnv({
        NODE_ENV: "production",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test/v1/traces",
        OTEL_SERVICE_NAME: "workflow-runtime-test",
        WORKFLOW_RUNTIME_OTEL_ENABLED: "true",
      }),
      {
        enabled: true,
        exporterEndpoint: "https://otel.example.test/v1/traces",
        serviceName: "workflow-runtime-test",
      },
    );
  });

  test("provides reusable disabled setup without a collector", async () => {
    const config = WorkflowRuntimeTelemetry.fromEnv({});
    const service = await Effect.runPromise(
      Effect.flatMap(WorkflowRuntimeTelemetry, (telemetry) =>
        Effect.succeed(telemetry.config),
      ).pipe(Effect.provide(WorkflowRuntimeTelemetry.layerFromConfig(config))),
    );

    assert.deepEqual(service, config);
  });
});
