import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  type GeneratedAsset,
  projectGeneratedAssetToTaskOutput,
} from "~/features/runtime/assets/generated-asset-projection";

type Assert<T extends true> = T;
type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;
type _GeneratedPrimaryAssetKindsStayScopedToRuntimeOverhaul = Assert<
  IsExact<GeneratedAsset["kind"], "text" | "image" | "video">
>;

describe("generated Asset catalog projection", () => {
  test("projects one generated CDN media asset into a renderable Task Status Event output", () => {
    const imageOutput = projectGeneratedAssetToTaskOutput([
      {
        assetId: "asset-image-1",
        cdnUrl:
          "https://cdn.example.com/workflows/workflow-1/asset-image-1.png",
        contentType: "image/png",
        kind: "image",
      },
    ]);
    const videoOutput = projectGeneratedAssetToTaskOutput([
      {
        assetId: "asset-video-1",
        cdnUrl:
          "https://cdn.example.com/workflows/workflow-1/asset-video-1.mp4",
        contentType: "video/mp4",
        kind: "video",
      },
    ]);

    assert.deepEqual(imageOutput, {
      assetId: "asset-image-1",
      cdnUrl: "https://cdn.example.com/workflows/workflow-1/asset-image-1.png",
      contentType: "image/png",
      kind: "cdn-asset",
    });
    assert.deepEqual(videoOutput, {
      assetId: "asset-video-1",
      cdnUrl: "https://cdn.example.com/workflows/workflow-1/asset-video-1.mp4",
      contentType: "video/mp4",
      kind: "cdn-asset",
    });
  });

  test("projects one generated inline text asset into a renderable Task Status Event output", () => {
    const output = projectGeneratedAssetToTaskOutput([
      {
        assetId: "asset-text-1",
        kind: "text",
        text: "Full generated script text.",
      },
    ]);

    assert.deepEqual(output, {
      assetId: "asset-text-1",
      kind: "inline-text-asset",
      text: "Full generated script text.",
    });
  });

  test("returns a domain error when a completed Task Run has no primary generated Asset", () => {
    const output = projectGeneratedAssetToTaskOutput([]);

    assert.deepEqual(output, {
      actualAssetCount: 0,
      kind: "INVALID_PRIMARY_GENERATED_ASSET_COUNT",
      message:
        "Completed Task Run must produce exactly one primary generated Asset.",
    });
  });

  test("returns a domain error when a completed Task Run has multiple primary generated Assets", () => {
    const output = projectGeneratedAssetToTaskOutput([
      {
        assetId: "asset-image-1",
        cdnUrl:
          "https://cdn.example.com/workflows/workflow-1/asset-image-1.png",
        contentType: "image/png",
        kind: "image",
      },
      {
        assetId: "asset-video-1",
        cdnUrl:
          "https://cdn.example.com/workflows/workflow-1/asset-video-1.mp4",
        contentType: "video/mp4",
        kind: "video",
      },
    ]);

    assert.deepEqual(output, {
      actualAssetCount: 2,
      kind: "INVALID_PRIMARY_GENERATED_ASSET_COUNT",
      message:
        "Completed Task Run must produce exactly one primary generated Asset.",
    });
  });
});
