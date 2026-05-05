import { describe, test } from "bun:test";
import assert from "node:assert/strict";

import {
  getWorkflowUploadAssetKind,
  shouldInlineAssetPreview,
} from "~/lib/workflow/assets";

describe("workflow asset helpers", () => {
  test("infers only media asset kinds for user uploads", () => {
    assert.equal(getWorkflowUploadAssetKind({ type: "image/png" }), "image");
    assert.equal(getWorkflowUploadAssetKind({ type: "video/mp4" }), "video");
    assert.equal(getWorkflowUploadAssetKind({ type: "text/plain" }), null);
  });

  test("inlines previews only for small supported image assets", () => {
    assert.equal(
      shouldInlineAssetPreview({
        kind: "text",
        mimeType: "text/plain",
        size: 12,
      }),
      false,
    );
    assert.equal(
      shouldInlineAssetPreview({
        kind: "image",
        mimeType: "image/png",
        size: 12,
      }),
      true,
    );
  });
});
