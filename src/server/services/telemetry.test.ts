import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { TelemetryService } from "~/server/services/telemetry";

describe("TelemetryService", () => {
  test("provides reusable disabled setup without a collector", async () => {
    const config = {
      enabled: false,
      exporterEndpoint: null,
      serviceName: "faceless-factory-server",
    };
    const service = await Effect.runPromise(
      Effect.flatMap(TelemetryService, (telemetry) =>
        Effect.succeed(telemetry.config),
      ).pipe(Effect.provide(TelemetryService.layerFromConfig(config))),
    );

    assert.deepEqual(service, config);
  });
});
