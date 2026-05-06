import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  buildVideoGenerationRequest,
  createDefaultVideoGeneratorSettings,
  type GeneratorControlDefinition,
  getVideoGeneratorControlDefinitions,
  setVideoGeneratorMode,
} from "~/features/workflow/generator-models";
import { VEO_31_FAST_MODEL_ID } from "~/features/workflow/types";

function isDurationSelectControl(
  control: GeneratorControlDefinition,
): control is Extract<GeneratorControlDefinition, { type: "select" }> {
  return control.type === "select" && control.key === "durationSeconds";
}

describe("video generator model options", () => {
  test("veo ingredients mode only exposes supported reference video duration", () => {
    const durationControl = getVideoGeneratorControlDefinitions(
      VEO_31_FAST_MODEL_ID,
      "ingredients",
    ).find(isDurationSelectControl);

    assert.deepEqual(durationControl?.options, [{ label: "8s", value: "8" }]);
    assert.equal(
      createDefaultVideoGeneratorSettings().config.durationSeconds,
      8,
    );
  });

  test("veo ingredients requests coerce stale four second config to eight seconds", () => {
    const request = buildVideoGenerationRequest({
      idempotencyKey: "test",
      imageInputsByHandle: {},
      prompt: "Walk forward.",
      settings: {
        config: {
          aspectRatio: "16:9",
          durationSeconds: 4,
          generateAudio: true,
          resolution: "720p",
        },
        mode: "ingredients",
        model: VEO_31_FAST_MODEL_ID,
      },
    });

    assert.equal(request.durationSeconds, 8);
  });

  test("first-last-frame mode keeps the broader duration set", () => {
    const settings = setVideoGeneratorMode(
      createDefaultVideoGeneratorSettings(),
      "first-last-frame",
    );
    const durationControl = getVideoGeneratorControlDefinitions(
      VEO_31_FAST_MODEL_ID,
      "first-last-frame",
    ).find(isDurationSelectControl);

    assert.deepEqual(
      durationControl?.options.map((option) => option.value),
      ["4", "6", "8"],
    );
    assert.equal(settings.config.durationSeconds, 8);
  });
});
