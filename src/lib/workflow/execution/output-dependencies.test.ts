import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
  type WorkflowDocumentNode,
} from "~/lib/workflow/document";
import {
  buildWorkflowApprovedOutputProjection,
  buildWorkflowOutputProjection,
  getWorkflowVisibleCompletionOutputs,
} from "~/lib/workflow/execution/artifact-projection";
import {
  areWorkflowOutputJobsSettled,
  buildWorkflowOutputDependencyPlan,
  getFailedWorkflowOutputClosure,
  getReadyWorkflowOutputJobs,
  getWorkflowOutputKey,
  getWorkflowOutputSettlement,
} from "~/lib/workflow/execution/output-dependencies";
import { WorkflowExecutionPlanner } from "~/lib/workflow/execution/planning";
import type {
  NodeOutputArtifact,
  WorkflowOutputArtifacts,
} from "~/lib/workflow/execution/types";
import {
  getErroredWorkflowOutputResults,
  getSuccessfulWorkflowOutputs,
  isWorkflowExecutionLockingStatus,
} from "~/lib/workflow/execution/types";
import { getWorkflowNodeRuntimeValue } from "~/lib/workflow/graph";
import { PROMPT_INPUT_HANDLE_ID } from "~/lib/workflow/node-definitions";
import type { WorkflowAsset } from "~/lib/workflow/types";

const imageInput = (index: number) => `image-input-${index}`;

function node<K extends WorkflowDocumentNode["kind"]>(kind: K, id: string) {
  const created = createWorkflowNode(kind, 0);
  return { ...created, id } as Extract<WorkflowDocumentNode, { kind: K }>;
}

function outputPlan(params: {
  document: WorkflowDocument;
  iterations: Record<string, number>;
  targetNodeIds: string[];
}) {
  return buildWorkflowOutputDependencyPlan({
    document: params.document,
    generatorIterationById: new Map(
      Object.entries(params.iterations).map(([nodeId, iterations]) => [
        nodeId,
        { iterations },
      ]),
    ),
    targetNodeIds: params.targetNodeIds,
  });
}

function executionOutputPlan(params: {
  document: WorkflowDocument;
  targetNodeIds: string[];
}) {
  const executionPlan = WorkflowExecutionPlanner.forTaskScheduling({
    document: params.document,
    targetNodeIds: params.targetNodeIds,
  });
  return buildWorkflowOutputDependencyPlan({
    document: params.document,
    generatorIterationById: executionPlan.generatorIterationById,
    targetNodeIds: params.targetNodeIds,
  });
}

function output(
  nodeId: string,
  outputIndex: number,
  params?: Partial<NodeOutputArtifact>,
): NodeOutputArtifact {
  return {
    attempt: 0,
    documentRevision: null,
    idempotencyKey: `${nodeId}:${outputIndex}`,
    inputHash: `${nodeId}:${outputIndex}`,
    outputIndex,
    model: null,
    nodeId,
    ownerUserId: "user",
    projectId: "project",
    promptSnapshot: null,
    reviewStatus: null,
    executionId: "run",
    value: { items: [`${nodeId}:${outputIndex}`], type: "text" },
    ...params,
  };
}

function imageOutput(
  nodeId: string,
  outputIndex: number,
  params?: Partial<NodeOutputArtifact>,
): NodeOutputArtifact {
  const asset = workflowAsset(`${nodeId}-${outputIndex}`);
  return output(nodeId, outputIndex, {
    value: { items: [[asset]], type: "image" },
    ...params,
  });
}

function workflowAsset(id: string): WorkflowAsset {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    externalUri: null,
    fileName: `${id}.png`,
    id,
    kind: "image",
    mimeType: "image/png",
    model: null,
    size: 1,
    source: "generated",
    storagePath: `generated/${id}.png`,
    url: `/api/assets/${id}`,
  };
}

function success(output: NodeOutputArtifact) {
  return { ...output, status: "success" as const };
}

function waitingForReview(output: NodeOutputArtifact) {
  return { ...output, status: "waiting_for_review" as const };
}

function errorResult(nodeId: string, outputIndex: number, attempt: number) {
  return {
    attempt,
    error: "output failed",
    failedAt: "2026-01-01T00:00:00.000Z",
    outputIndex,
    nodeId,
    ownerUserId: "user",
    projectId: "project",
    executionId: "run",
    status: "error" as const,
  };
}

function visibleOutputKeys(artifacts: WorkflowOutputArtifacts) {
  return new Set(
    getWorkflowVisibleCompletionOutputs(artifacts).map(getWorkflowOutputKey),
  );
}

function materializedBlockedOutputKeys(artifacts: WorkflowOutputArtifacts) {
  const completed = visibleOutputKeys(artifacts);
  return new Set(
    artifacts.outputResults
      .map(getWorkflowOutputKey)
      .filter((key) => !completed.has(key)),
  );
}

describe("workflow output dependencies", () => {
  test("rolling pair maps video output 0 to current and shifted image outputs", () => {
    const image = node("imageGenerator", "image");
    const reorder = {
      ...node("outputReorder", "shift"),
      shift: 1,
      valueType: "image" as const,
    };
    const video = node("videoGenerator", "video");
    const document: WorkflowDocument = {
      edges: [
        {
          id: "image-video-current",
          source: image.id,
          sourceHandle: "images",
          target: video.id,
          targetHandle: imageInput(0),
        },
        {
          id: "image-shift",
          source: image.id,
          sourceHandle: "images",
          target: reorder.id,
          targetHandle: "input",
        },
        {
          id: "shift-video-next",
          source: reorder.id,
          sourceHandle: "output",
          target: video.id,
          targetHandle: imageInput(1),
        },
      ],
      nodes: [image, reorder, video],
      version: WORKFLOW_DOCUMENT_VERSION,
    };

    const plan = outputPlan({
      document,
      iterations: { image: 2, video: 2 },
      targetNodeIds: [image.id, video.id],
    });

    assert.deepEqual(
      plan.jobs.find((job) => job.nodeId === video.id && job.outputIndex === 0)
        ?.dependencies,
      [
        { outputIndex: 0, nodeId: image.id },
        { outputIndex: 1, nodeId: image.id },
      ],
    );
  });

  test("manual output reorder maps dependencies and runtime outputs", () => {
    const image = {
      ...node("imageGenerator", "image"),
      outputs: [
        [workflowAsset("image-0")],
        [workflowAsset("image-1")],
        [workflowAsset("image-2")],
      ],
    };
    const reorder = {
      ...node("outputReorder", "manual"),
      mode: "manual" as const,
      order: [2, 0, 1],
      valueType: "image" as const,
    };
    const video = node("videoGenerator", "video");
    const document: WorkflowDocument = {
      edges: [
        {
          id: "image-reorder",
          source: image.id,
          sourceHandle: "images",
          target: reorder.id,
          targetHandle: "input",
        },
        {
          id: "reorder-video",
          source: reorder.id,
          sourceHandle: "output",
          target: video.id,
          targetHandle: imageInput(0),
        },
      ],
      nodes: [image, reorder, video],
      version: WORKFLOW_DOCUMENT_VERSION,
    };

    const plan = outputPlan({
      document,
      iterations: { image: 3, video: 3 },
      targetNodeIds: [image.id, video.id],
    });

    assert.deepEqual(
      plan.jobs.find((job) => job.nodeId === video.id && job.outputIndex === 0)
        ?.dependencies,
      [{ outputIndex: 2, nodeId: image.id }],
    );
    const reorderValue = getWorkflowNodeRuntimeValue(document, reorder.id);
    assert.equal(reorderValue?.type, "image");
    assert.deepEqual(
      reorderValue?.type === "image"
        ? reorderValue.items.map((assets) => assets[0]?.id)
        : [],
      ["image-2", "image-0", "image-1"],
    );
  });

  test("first-last-frame waits on transformed upstream generator outputs outside the job target set", () => {
    const image = node("imageGenerator", "image");
    const reorder = {
      ...node("outputReorder", "shift"),
      shift: 1,
      valueType: "image" as const,
    };
    const video = {
      ...node("videoGenerator", "video"),
      mode: "first-last-frame" as const,
    };
    const document: WorkflowDocument = {
      edges: [
        {
          id: "image-video-first",
          source: image.id,
          sourceHandle: "images",
          target: video.id,
          targetHandle: "first-frame",
        },
        {
          id: "image-shift",
          source: image.id,
          sourceHandle: "images",
          target: reorder.id,
          targetHandle: "input",
        },
        {
          id: "shift-video-last",
          source: reorder.id,
          sourceHandle: "output",
          target: video.id,
          targetHandle: "last-frame",
        },
      ],
      nodes: [image, reorder, video],
      version: WORKFLOW_DOCUMENT_VERSION,
    };

    const plan = outputPlan({
      document,
      iterations: { image: 3, video: 3 },
      targetNodeIds: [video.id],
    });

    assert.deepEqual(
      plan.jobs.find((job) => job.nodeId === video.id && job.outputIndex === 1)
        ?.dependencies,
      [
        { outputIndex: 1, nodeId: image.id },
        { outputIndex: 2, nodeId: image.id },
      ],
    );
    assert.equal(
      getReadyWorkflowOutputJobs({
        completedOutputs: new Set([`${image.id}:1`]),
        plan,
      }).some((job) => job.nodeId === video.id && job.outputIndex === 1),
      false,
    );
  });

  test("readiness waits until every visible dependency is complete", () => {
    const plan = {
      jobs: [
        { dependencies: [], outputIndex: 0, nodeId: "image" },
        {
          dependencies: [
            { outputIndex: 0, nodeId: "image" },
            { outputIndex: 1, nodeId: "image" },
          ],
          outputIndex: 0,
          nodeId: "video",
        },
      ],
    };

    assert.equal(
      getReadyWorkflowOutputJobs({
        completedOutputs: new Set(["image:0"]),
        plan,
      }).some((job) => job.nodeId === "video"),
      false,
    );

    assert.deepEqual(
      getReadyWorkflowOutputJobs({
        completedOutputs: new Set(["image:0", "image:1"]),
        plan,
      }),
      [
        {
          dependencies: [
            { outputIndex: 0, nodeId: "image" },
            { outputIndex: 1, nodeId: "image" },
          ],
          outputIndex: 0,
          nodeId: "video",
        },
      ],
    );
  });

  test("reviewed raw output is not a visible completion until approved", () => {
    const artifacts: WorkflowOutputArtifacts = {
      outputResults: [
        waitingForReview(output("reviewed", 0, { reviewStatus: "pending" })),
      ],
    };

    assert.deepEqual(getWorkflowVisibleCompletionOutputs(artifacts), []);
    assert.deepEqual(
      getWorkflowVisibleCompletionOutputs({
        outputResults: [
          success(output("reviewed", 0, { reviewStatus: "approved" })),
        ],
      }).map(getWorkflowOutputKey),
      ["reviewed:0"],
    );
  });

  test("pending reviewed output projects review payload without visible completion", () => {
    const reviewed = {
      ...node("llmGenerator", "reviewed"),
      outputs: [""],
      reviewEnabled: true,
    };
    const artifacts: WorkflowOutputArtifacts = {
      outputResults: [
        waitingForReview(
          output("reviewed", 0, {
            reviewStatus: "pending",
            value: { items: ["candidate text"], type: "text" },
          }),
        ),
      ],
    };

    const projected = buildWorkflowOutputProjection({
      artifacts,
      document: {
        edges: [],
        nodes: [reviewed],
        version: WORKFLOW_DOCUMENT_VERSION,
      },
    });
    const [projectedNode] = projected.nodes;

    assert.deepEqual(getWorkflowVisibleCompletionOutputs(artifacts), []);
    assert.equal(projectedNode?.kind, "llmGenerator");
    assert.equal(
      projectedNode?.kind === "llmGenerator"
        ? projectedNode.review.outputs[0]?.text
        : null,
      "candidate text",
    );
  });

  test("review approval does not unblock rolling pair until every visible source output is approved", () => {
    const image = node("imageGenerator", "image");
    const reorder = {
      ...node("outputReorder", "shift"),
      shift: 1,
      valueType: "image" as const,
    };
    const video = node("videoGenerator", "video");
    const document: WorkflowDocument = {
      edges: [
        {
          id: "image-video-current",
          source: image.id,
          sourceHandle: "images",
          target: video.id,
          targetHandle: imageInput(0),
        },
        {
          id: "image-shift",
          source: image.id,
          sourceHandle: "images",
          target: reorder.id,
          targetHandle: "input",
        },
        {
          id: "shift-video-next",
          source: reorder.id,
          sourceHandle: "output",
          target: video.id,
          targetHandle: imageInput(1),
        },
      ],
      nodes: [image, reorder, video],
      version: WORKFLOW_DOCUMENT_VERSION,
    };
    const plan = outputPlan({
      document,
      iterations: { image: 2, video: 1 },
      targetNodeIds: [image.id, video.id],
    });
    const artifacts: WorkflowOutputArtifacts = {
      outputResults: [
        success(output(image.id, 0, { reviewStatus: "approved" })),
        success(output(image.id, 1, { reviewStatus: "pending" })),
      ],
    };

    assert.equal(
      getReadyWorkflowOutputJobs({
        blockedOutputs: materializedBlockedOutputKeys(artifacts),
        completedOutputs: visibleOutputKeys(artifacts),
        plan,
      }).some((job) => job.nodeId === video.id && job.outputIndex === 0),
      false,
    );

    assert.equal(
      getReadyWorkflowOutputJobs({
        blockedOutputs: materializedBlockedOutputKeys({
          outputResults: artifacts.outputResults.map((result) =>
            result.status === "success"
              ? { ...result, reviewStatus: "approved" as const }
              : result,
          ),
        }),
        completedOutputs: visibleOutputKeys({
          outputResults: artifacts.outputResults.map((result) =>
            result.status === "success"
              ? { ...result, reviewStatus: "approved" as const }
              : result,
          ),
        }),
        plan,
      }).some((job) => job.nodeId === video.id && job.outputIndex === 0),
      true,
    );
  });

  test("approved review projection keeps pending output cardinality for downstream transforms", () => {
    const reviewed = {
      ...node("imageGenerator", "reviewed"),
      outputs: [[workflowAsset("reviewed-0")], [workflowAsset("reviewed-1")]],
      reviewEnabled: true,
    };
    const image = node("imageGenerator", "image");
    const reorder = {
      ...node("outputReorder", "shift"),
      shift: 1,
      valueType: "image" as const,
    };
    const video = {
      ...node("videoGenerator", "video"),
      mode: "first-last-frame" as const,
    };
    const document: WorkflowDocument = {
      edges: [
        {
          id: "reviewed-image",
          source: reviewed.id,
          sourceHandle: "images",
          target: image.id,
          targetHandle: imageInput(0),
        },
        {
          id: "image-video-first",
          source: image.id,
          sourceHandle: "images",
          target: video.id,
          targetHandle: "first-frame",
        },
        {
          id: "image-shift",
          source: image.id,
          sourceHandle: "images",
          target: reorder.id,
          targetHandle: "input",
        },
        {
          id: "shift-video-last",
          source: reorder.id,
          sourceHandle: "output",
          target: video.id,
          targetHandle: "last-frame",
        },
      ],
      nodes: [reviewed, image, reorder, video],
      version: WORKFLOW_DOCUMENT_VERSION,
    };
    const artifacts: WorkflowOutputArtifacts = {
      outputResults: [
        success(imageOutput(reviewed.id, 0, { reviewStatus: "approved" })),
        success(imageOutput(reviewed.id, 1, { reviewStatus: "approved" })),
        success(imageOutput(reviewed.id, 2, { reviewStatus: "regenerating" })),
        success(imageOutput(image.id, 0)),
        success(imageOutput(image.id, 1)),
      ],
    };
    const projected = buildWorkflowApprovedOutputProjection({
      artifacts,
      document,
    });
    const plan = executionOutputPlan({
      document: projected,
      targetNodeIds: [reviewed.id, image.id, video.id],
    });

    assert.deepEqual(
      plan.jobs.find((job) => job.nodeId === video.id && job.outputIndex === 1)
        ?.dependencies,
      [
        { outputIndex: 1, nodeId: image.id },
        { outputIndex: 2, nodeId: image.id },
      ],
    );
    assert.equal(
      getReadyWorkflowOutputJobs({
        blockedOutputs: materializedBlockedOutputKeys(artifacts),
        completedOutputs: visibleOutputKeys(artifacts),
        plan,
      }).some((job) => job.nodeId === video.id && job.outputIndex === 1),
      false,
    );
  });

  test("rolling pair can run a satisfied output while another source output is still blocked", () => {
    const image = node("imageGenerator", "image");
    const reorder = {
      ...node("outputReorder", "shift"),
      shift: 1,
      valueType: "image" as const,
    };
    const video = node("videoGenerator", "video");
    const document: WorkflowDocument = {
      edges: [
        {
          id: "image-video-current",
          source: image.id,
          sourceHandle: "images",
          target: video.id,
          targetHandle: imageInput(0),
        },
        {
          id: "image-shift",
          source: image.id,
          sourceHandle: "images",
          target: reorder.id,
          targetHandle: "input",
        },
        {
          id: "shift-video-next",
          source: reorder.id,
          sourceHandle: "output",
          target: video.id,
          targetHandle: imageInput(1),
        },
      ],
      nodes: [image, reorder, video],
      version: WORKFLOW_DOCUMENT_VERSION,
    };
    const plan = outputPlan({
      document,
      iterations: { image: 3, video: 3 },
      targetNodeIds: [image.id, video.id],
    });
    for (const [completedOutputs, readyOutputIndex] of [
      [[0, 1], 0],
      [[1, 2], 1],
      [[0, 2], 2],
    ] as const) {
      const readyJobs = getReadyWorkflowOutputJobs({
        completedOutputs: new Set(
          completedOutputs.map((outputIndex) => `${image.id}:${outputIndex}`),
        ),
        plan,
      });

      assert.equal(
        readyJobs.some(
          (job) =>
            job.nodeId === video.id && job.outputIndex === readyOutputIndex,
        ),
        true,
      );
      assert.equal(
        readyJobs.filter((job) => job.nodeId === video.id).length,
        1,
      );
    }
  });

  test("prompt dependencies ignore unreferenced variables", () => {
    const used = node("llmGenerator", "used");
    const unused = node("llmGenerator", "unused");
    const prompt = {
      ...node("prompt", "prompt"),
      prompt: "{{used}}",
      variables: [
        { key: "used", label: "Used" },
        { key: "unused", label: "Unused" },
      ],
    };
    const image = node("imageGenerator", "image");
    const document: WorkflowDocument = {
      edges: [
        {
          id: "used-prompt",
          source: used.id,
          sourceHandle: "text",
          target: prompt.id,
          targetHandle: "used",
        },
        {
          id: "unused-prompt",
          source: unused.id,
          sourceHandle: "text",
          target: prompt.id,
          targetHandle: "unused",
        },
        {
          id: "prompt-image",
          source: prompt.id,
          sourceHandle: "text",
          target: image.id,
          targetHandle: PROMPT_INPUT_HANDLE_ID,
        },
      ],
      nodes: [used, unused, prompt, image],
      version: WORKFLOW_DOCUMENT_VERSION,
    };

    const dependencies = outputPlan({
      document,
      iterations: { image: 1, unused: 1, used: 1 },
      targetNodeIds: [used.id, unused.id, image.id],
    }).jobs.find((job) => job.nodeId === image.id)?.dependencies;

    assert.deepEqual(dependencies, [{ outputIndex: 0, nodeId: used.id }]);
  });

  test("blocked node-output work is not returned ready again", () => {
    const job = { dependencies: [], outputIndex: 0, nodeId: "image" };
    assert.deepEqual(
      getReadyWorkflowOutputJobs({
        blockedOutputs: new Set([getWorkflowOutputKey(job)]),
        completedOutputs: new Set(),
        plan: { jobs: [job] },
      }),
      [],
    );
  });

  test("failed source outputs transitively settle dependent outputs", () => {
    const plan = {
      jobs: [
        { dependencies: [], outputIndex: 0, nodeId: "image" },
        {
          dependencies: [{ outputIndex: 0, nodeId: "image" }],
          outputIndex: 0,
          nodeId: "video",
        },
      ],
    };
    const failedOutputs = new Set(["image:0"]);

    assert.deepEqual(
      getFailedWorkflowOutputClosure({ failedOutputs, plan }),
      new Set(["image:0", "video:0"]),
    );
    assert.equal(
      areWorkflowOutputJobsSettled({
        completedOutputs: new Set(),
        failedOutputs,
        plan,
      }),
      true,
    );
    assert.deepEqual(
      getReadyWorkflowOutputJobs({
        blockedOutputs: getFailedWorkflowOutputClosure({ failedOutputs, plan }),
        completedOutputs: new Set(),
        plan,
      }),
      [],
    );
  });

  test("unrelated outputs remain runnable after a output failure", () => {
    const plan = {
      jobs: [
        { dependencies: [], outputIndex: 0, nodeId: "image" },
        { dependencies: [], outputIndex: 1, nodeId: "image" },
        {
          dependencies: [{ outputIndex: 0, nodeId: "image" }],
          outputIndex: 0,
          nodeId: "video",
        },
        {
          dependencies: [{ outputIndex: 1, nodeId: "image" }],
          outputIndex: 1,
          nodeId: "video",
        },
      ],
    };
    const failedClosure = getFailedWorkflowOutputClosure({
      failedOutputs: new Set(["image:0"]),
      plan,
    });

    assert.deepEqual(
      getReadyWorkflowOutputJobs({
        blockedOutputs: failedClosure,
        completedOutputs: new Set(["image:1"]),
        plan,
      }),
      [
        {
          dependencies: [{ outputIndex: 1, nodeId: "image" }],
          outputIndex: 1,
          nodeId: "video",
        },
      ],
    );
    assert.equal(
      areWorkflowOutputJobsSettled({
        completedOutputs: new Set(["image:1", "video:1"]),
        failedOutputs: new Set(["image:0"]),
        plan,
      }),
      true,
    );
  });

  test("durable output failures settle dependent outputs and leave siblings runnable", () => {
    const plan = {
      jobs: [
        { dependencies: [], outputIndex: 0, nodeId: "image" },
        { dependencies: [], outputIndex: 1, nodeId: "image" },
        {
          dependencies: [{ outputIndex: 0, nodeId: "image" }],
          outputIndex: 0,
          nodeId: "video",
        },
        {
          dependencies: [{ outputIndex: 1, nodeId: "image" }],
          outputIndex: 1,
          nodeId: "video",
        },
      ],
    };
    const artifacts: WorkflowOutputArtifacts = {
      outputResults: [
        success(output("image", 1)),
        {
          attempt: 0,
          error: "output failed",
          failedAt: "2026-01-01T00:00:00.000Z",
          outputIndex: 0,
          nodeId: "image",
          ownerUserId: "user",
          projectId: "project",
          executionId: "run",
          status: "error",
        },
      ],
    };

    const settlement = getWorkflowOutputSettlement({ artifacts, plan });

    assert.deepEqual(settlement.failedClosure, new Set(["image:0", "video:0"]));
    assert.equal(settlement.settled, false);
    assert.deepEqual(
      getReadyWorkflowOutputJobs({
        blockedOutputs: settlement.blockedOutputs,
        completedOutputs: settlement.completedOutputs,
        plan,
      }),
      [
        {
          dependencies: [{ outputIndex: 1, nodeId: "image" }],
          outputIndex: 1,
          nodeId: "video",
        },
      ],
    );

    assert.equal(
      getWorkflowOutputSettlement({
        artifacts: {
          ...artifacts,
          outputResults: [
            ...artifacts.outputResults,
            success(output("video", 1)),
          ],
        },
        plan,
      }).settled,
      true,
    );
    assert.equal(isWorkflowExecutionLockingStatus("error"), false);
  });

  test("later successful attempt supersedes stale output error", () => {
    const artifacts: WorkflowOutputArtifacts = {
      outputResults: [
        errorResult("image", 0, 0),
        success({ ...output("image", 0), attempt: 1 }),
      ],
    };
    const settlement = getWorkflowOutputSettlement({
      artifacts,
      plan: { jobs: [{ dependencies: [], outputIndex: 0, nodeId: "image" }] },
    });

    assert.deepEqual(getErroredWorkflowOutputResults(artifacts), []);
    assert.deepEqual(settlement.completedOutputs, new Set(["image:0"]));
    assert.deepEqual(settlement.failedOutputs, new Set());
    assert.equal(settlement.settled, true);
  });

  test("later error attempt supersedes stale successful completion", () => {
    const artifacts: WorkflowOutputArtifacts = {
      outputResults: [success(output("image", 0)), errorResult("image", 0, 1)],
    };
    const settlement = getWorkflowOutputSettlement({
      artifacts,
      plan: { jobs: [{ dependencies: [], outputIndex: 0, nodeId: "image" }] },
    });

    assert.deepEqual(getSuccessfulWorkflowOutputs(artifacts), []);
    assert.deepEqual(settlement.completedOutputs, new Set());
    assert.deepEqual(settlement.failedOutputs, new Set(["image:0"]));
    assert.equal(settlement.settled, true);
  });
});
