import type { RenderableTaskOutput } from "~/features/runtime/events/task-status-events";

export type GeneratedAssetKind = "text" | "image" | "video";
type GeneratedCdnAssetKind = Exclude<GeneratedAssetKind, "text">;

export type GeneratedCdnAsset = {
  readonly assetId: string;
  readonly cdnUrl: string;
  readonly contentType: string;
  readonly kind: GeneratedCdnAssetKind;
};

export type GeneratedInlineTextAsset = {
  readonly assetId: string;
  readonly kind: Extract<GeneratedAssetKind, "text">;
  readonly text: string;
};

export type GeneratedAsset = GeneratedCdnAsset | GeneratedInlineTextAsset;

export type GeneratedAssetProjectionError = {
  readonly actualAssetCount: number;
  readonly kind: "INVALID_PRIMARY_GENERATED_ASSET_COUNT";
  readonly message: "Completed Task Run must produce exactly one primary generated Asset.";
};

export type GeneratedAssetProjectionResult =
  | RenderableTaskOutput
  | GeneratedAssetProjectionError;

const invalidPrimaryGeneratedAssetCountMessage =
  "Completed Task Run must produce exactly one primary generated Asset." as const;

export function projectGeneratedAssetToTaskOutput(
  assets: readonly GeneratedAsset[],
): GeneratedAssetProjectionResult {
  if (assets.length !== 1) {
    return {
      actualAssetCount: assets.length,
      kind: "INVALID_PRIMARY_GENERATED_ASSET_COUNT",
      message: invalidPrimaryGeneratedAssetCountMessage,
    };
  }

  const asset = assets[0];
  if (!asset) {
    return {
      actualAssetCount: 0,
      kind: "INVALID_PRIMARY_GENERATED_ASSET_COUNT",
      message: invalidPrimaryGeneratedAssetCountMessage,
    };
  }

  return asset.kind === "text"
    ? {
        assetId: asset.assetId,
        kind: "inline-text-asset",
        text: asset.text,
      }
    : {
        assetId: asset.assetId,
        cdnUrl: asset.cdnUrl,
        contentType: asset.contentType,
        kind: "cdn-asset",
      };
}
