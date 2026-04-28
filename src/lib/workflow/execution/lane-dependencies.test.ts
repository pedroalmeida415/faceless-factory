import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
  type WorkflowDocumentNode,
} from "~/lib/workflow/document";
import {
  buildWorkflowRunProjection,
  getWorkflowVisibleCompletionOutputs,
} from "~/lib/workflow/execution/artifact-projection";
import {
  areWorkflowLaneJobsSettled,
  buildWorkflowLaneDependencyPlan,
  getFailedWorkflowLaneClosure,
  getReadyWorkflowLaneJobs,
  getWorkflowLaneKey,
  getWorkflowLaneSettlement,
} from "~/lib/workflow/execution/lane-dependencies";
import type {
  NodeLaneOutputArtifact,
  WorkflowRunArtifacts,
} from "~/lib/workflow/execution/types";
import {
  getErroredWorkflowLaneResults,
  getSuccessfulWorkflowLaneOutputs,
  isWorkflowRunLockingStatus,
} from "~/lib/workflow/execution/types";
import { PROMPT_INPUT_HANDLE_ID } from "~/lib/workflow/node-definitions";

const imageInput = (index: number) => `image-input-${index}`;

function node<K extends WorkflowDocumentNode["kind"]>(kind: K, id: string) {
  const created = createWorkflowNode(kind, 0);
  return { ...created, id } as Extract<WorkflowDocumentNode, { kind: K }>;
}

function lanePlan(params: {
  document: WorkflowDocument;
  iterations: Record<string, number>;
  targetNodeIds: string[];
}) {
  return buildWorkflowLaneDependencyPlan({
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

function output(
  nodeId: string,
  laneIndex: number,
  params?: Partial<NodeLaneOutputArtifact>,
): NodeLaneOutputArtifact {
  return {
    attempt: 0,
    documentRevision: null,
    idempotencyKey: `${nodeId}:${laneIndex}`,
    inputHash: `${nodeId}:${laneIndex}`,
    laneIndex,
    model: null,
    nodeId,
    ownerUserId: "user",
    projectId: "project",
    promptSnapshot: null,
    reviewStatus: null,
    runId: "run",
    value: { lanes: [`${nodeId}:${laneIndex}`], type: "text" },
    ...params,
  };
}

function success(output: NodeLaneOutputArtifact) {
  return { ...output, status: "success" as const };
}

function errorResult(nodeId: string, laneIndex: number, attempt: number) {
  return {
    attempt,
    error: "lane failed",
    failedAt: "2026-01-01T00:00:00.000Z",
    laneIndex,
    nodeId,
    ownerUserId: "user",
    projectId: "project",
    runId: "run",
    status: "error" as const,
  };
}

function visibleLaneKeys(artifacts: WorkflowRunArtifacts) {
  return new Set(
    getWorkflowVisibleCompletionOutputs(artifacts).map(getWorkflowLaneKey),
  );
}

function materializedBlockedLaneKeys(artifacts: WorkflowRunArtifacts) {
  const completed = visibleLaneKeys(artifacts);
  return new Set(
    artifacts.laneResults
      .map(getWorkflowLaneKey)
      .filter((key) => !completed.has(key)),
  );
}

describe("workflow lane dependencies", () => {
  test("rolling pair maps video lane 0 to current and shifted image lanes", () => {
    const image = node("imageGenerator", "image");
    const reorder = {
      ...node("laneReorder", "shift"),
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

    const plan = lanePlan({
      document,
      iterations: { image: 2, video: 2 },
      targetNodeIds: [image.id, video.id],
    });

    assert.deepEqual(
      plan.jobs.find((job) => job.nodeId === video.id && job.laneIndex === 0)
        ?.dependencies,
      [
        { laneIndex: 0, nodeId: image.id },
        { laneIndex: 1, nodeId: image.id },
      ],
    );
  });

  test("first-last-frame waits on transformed upstream generator lanes outside the job target set", () => {
    const image = node("imageGenerator", "image");
    const reorder = {
      ...node("laneReorder", "shift"),
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

    const plan = lanePlan({
      document,
      iterations: { image: 3, video: 3 },
      targetNodeIds: [video.id],
    });

    assert.deepEqual(
      plan.jobs.find((job) => job.nodeId === video.id && job.laneIndex === 1)
        ?.dependencies,
      [
        { laneIndex: 1, nodeId: image.id },
        { laneIndex: 2, nodeId: image.id },
      ],
    );
    assert.equal(
      getReadyWorkflowLaneJobs({
        completedLanes: new Set([`${image.id}:1`]),
        plan,
      }).some((job) => job.nodeId === video.id && job.laneIndex === 1),
      false,
    );
  });

  test("readiness waits until every visible dependency is complete", () => {
    const plan = {
      jobs: [
        { dependencies: [], laneIndex: 0, nodeId: "image" },
        {
          dependencies: [
            { laneIndex: 0, nodeId: "image" },
            { laneIndex: 1, nodeId: "image" },
          ],
          laneIndex: 0,
          nodeId: "video",
        },
      ],
    };

    assert.equal(
      getReadyWorkflowLaneJobs({
        completedLanes: new Set(["image:0"]),
        plan,
      }).some((job) => job.nodeId === "video"),
      false,
    );

    assert.deepEqual(
      getReadyWorkflowLaneJobs({
        completedLanes: new Set(["image:0", "image:1"]),
        plan,
      }),
      [
        {
          dependencies: [
            { laneIndex: 0, nodeId: "image" },
            { laneIndex: 1, nodeId: "image" },
          ],
          laneIndex: 0,
          nodeId: "video",
        },
      ],
    );
  });

  test("reviewed raw output is not a visible completion until approved", () => {
    const artifacts: WorkflowRunArtifacts = {
      laneResults: [
        success(output("reviewed", 0, { reviewStatus: "pending" })),
      ],
    };

    assert.deepEqual(getWorkflowVisibleCompletionOutputs(artifacts), []);
    assert.deepEqual(
      getWorkflowVisibleCompletionOutputs({
        laneResults: [
          success(output("reviewed", 0, { reviewStatus: "approved" })),
        ],
      }).map(getWorkflowLaneKey),
      ["reviewed:0"],
    );
  });

  test("pending reviewed output projects review payload without visible completion", () => {
    const reviewed = {
      ...node("llmGenerator", "reviewed"),
      outputLanes: [""],
      reviewEnabled: true,
    };
    const artifacts: WorkflowRunArtifacts = {
      laneResults: [
        success(
          output("reviewed", 0, {
            reviewStatus: "pending",
            value: { lanes: ["candidate text"], type: "text" },
          }),
        ),
      ],
    };

    const projected = buildWorkflowRunProjection({
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
        ? projectedNode.review.lanes[0]?.text
        : null,
      "candidate text",
    );
  });

  test("review approval does not unblock rolling pair until every visible source lane is approved", () => {
    const image = node("imageGenerator", "image");
    const reorder = {
      ...node("laneReorder", "shift"),
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
    const plan = lanePlan({
      document,
      iterations: { image: 2, video: 1 },
      targetNodeIds: [image.id, video.id],
    });
    const artifacts: WorkflowRunArtifacts = {
      laneResults: [
        success(output(image.id, 0, { reviewStatus: "approved" })),
        success(output(image.id, 1, { reviewStatus: "pending" })),
      ],
    };

    assert.equal(
      getReadyWorkflowLaneJobs({
        blockedLanes: materializedBlockedLaneKeys(artifacts),
        completedLanes: visibleLaneKeys(artifacts),
        plan,
      }).some((job) => job.nodeId === video.id && job.laneIndex === 0),
      false,
    );

    assert.equal(
      getReadyWorkflowLaneJobs({
        blockedLanes: materializedBlockedLaneKeys({
          laneResults: artifacts.laneResults.map((result) =>
            result.status === "success"
              ? { ...result, reviewStatus: "approved" as const }
              : result,
          ),
        }),
        completedLanes: visibleLaneKeys({
          laneResults: artifacts.laneResults.map((result) =>
            result.status === "success"
              ? { ...result, reviewStatus: "approved" as const }
              : result,
          ),
        }),
        plan,
      }).some((job) => job.nodeId === video.id && job.laneIndex === 0),
      true,
    );
  });

  test("rolling pair can run a satisfied lane while another source lane is still blocked", () => {
    const image = node("imageGenerator", "image");
    const reorder = {
      ...node("laneReorder", "shift"),
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
    const plan = lanePlan({
      document,
      iterations: { image: 3, video: 3 },
      targetNodeIds: [image.id, video.id],
    });
    for (const [completedLanes, readyLaneIndex] of [
      [[0, 1], 0],
      [[1, 2], 1],
      [[0, 2], 2],
    ] as const) {
      const readyJobs = getReadyWorkflowLaneJobs({
        completedLanes: new Set(
          completedLanes.map((laneIndex) => `${image.id}:${laneIndex}`),
        ),
        plan,
      });

      assert.equal(
        readyJobs.some(
          (job) => job.nodeId === video.id && job.laneIndex === readyLaneIndex,
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

    const dependencies = lanePlan({
      document,
      iterations: { image: 1, unused: 1, used: 1 },
      targetNodeIds: [used.id, unused.id, image.id],
    }).jobs.find((job) => job.nodeId === image.id)?.dependencies;

    assert.deepEqual(dependencies, [{ laneIndex: 0, nodeId: used.id }]);
  });

  test("blocked node-lane work is not returned ready again", () => {
    const job = { dependencies: [], laneIndex: 0, nodeId: "image" };
    assert.deepEqual(
      getReadyWorkflowLaneJobs({
        blockedLanes: new Set([getWorkflowLaneKey(job)]),
        completedLanes: new Set(),
        plan: { jobs: [job] },
      }),
      [],
    );
  });

  test("failed source lanes transitively settle dependent lanes", () => {
    const plan = {
      jobs: [
        { dependencies: [], laneIndex: 0, nodeId: "image" },
        {
          dependencies: [{ laneIndex: 0, nodeId: "image" }],
          laneIndex: 0,
          nodeId: "video",
        },
      ],
    };
    const failedLanes = new Set(["image:0"]);

    assert.deepEqual(
      getFailedWorkflowLaneClosure({ failedLanes, plan }),
      new Set(["image:0", "video:0"]),
    );
    assert.equal(
      areWorkflowLaneJobsSettled({
        completedLanes: new Set(),
        failedLanes,
        plan,
      }),
      true,
    );
    assert.deepEqual(
      getReadyWorkflowLaneJobs({
        blockedLanes: getFailedWorkflowLaneClosure({ failedLanes, plan }),
        completedLanes: new Set(),
        plan,
      }),
      [],
    );
  });

  test("unrelated lanes remain runnable after a lane failure", () => {
    const plan = {
      jobs: [
        { dependencies: [], laneIndex: 0, nodeId: "image" },
        { dependencies: [], laneIndex: 1, nodeId: "image" },
        {
          dependencies: [{ laneIndex: 0, nodeId: "image" }],
          laneIndex: 0,
          nodeId: "video",
        },
        {
          dependencies: [{ laneIndex: 1, nodeId: "image" }],
          laneIndex: 1,
          nodeId: "video",
        },
      ],
    };
    const failedClosure = getFailedWorkflowLaneClosure({
      failedLanes: new Set(["image:0"]),
      plan,
    });

    assert.deepEqual(
      getReadyWorkflowLaneJobs({
        blockedLanes: failedClosure,
        completedLanes: new Set(["image:1"]),
        plan,
      }),
      [
        {
          dependencies: [{ laneIndex: 1, nodeId: "image" }],
          laneIndex: 1,
          nodeId: "video",
        },
      ],
    );
    assert.equal(
      areWorkflowLaneJobsSettled({
        completedLanes: new Set(["image:1", "video:1"]),
        failedLanes: new Set(["image:0"]),
        plan,
      }),
      true,
    );
  });

  test("durable lane failures settle dependent lanes and leave siblings runnable", () => {
    const plan = {
      jobs: [
        { dependencies: [], laneIndex: 0, nodeId: "image" },
        { dependencies: [], laneIndex: 1, nodeId: "image" },
        {
          dependencies: [{ laneIndex: 0, nodeId: "image" }],
          laneIndex: 0,
          nodeId: "video",
        },
        {
          dependencies: [{ laneIndex: 1, nodeId: "image" }],
          laneIndex: 1,
          nodeId: "video",
        },
      ],
    };
    const artifacts: WorkflowRunArtifacts = {
      laneResults: [
        success(output("image", 1)),
        {
          attempt: 0,
          error: "lane failed",
          failedAt: "2026-01-01T00:00:00.000Z",
          laneIndex: 0,
          nodeId: "image",
          ownerUserId: "user",
          projectId: "project",
          runId: "run",
          status: "error",
        },
      ],
    };

    const settlement = getWorkflowLaneSettlement({ artifacts, plan });

    assert.deepEqual(settlement.failedClosure, new Set(["image:0", "video:0"]));
    assert.equal(settlement.settled, false);
    assert.deepEqual(
      getReadyWorkflowLaneJobs({
        blockedLanes: settlement.blockedLanes,
        completedLanes: settlement.completedLanes,
        plan,
      }),
      [
        {
          dependencies: [{ laneIndex: 1, nodeId: "image" }],
          laneIndex: 1,
          nodeId: "video",
        },
      ],
    );

    assert.equal(
      getWorkflowLaneSettlement({
        artifacts: {
          ...artifacts,
          laneResults: [...artifacts.laneResults, success(output("video", 1))],
        },
        plan,
      }).settled,
      true,
    );
    assert.equal(isWorkflowRunLockingStatus("error"), false);
  });

  test("later successful attempt supersedes stale lane error", () => {
    const artifacts: WorkflowRunArtifacts = {
      laneResults: [
        errorResult("image", 0, 0),
        success({ ...output("image", 0), attempt: 1 }),
      ],
    };
    const settlement = getWorkflowLaneSettlement({
      artifacts,
      plan: { jobs: [{ dependencies: [], laneIndex: 0, nodeId: "image" }] },
    });

    assert.deepEqual(getErroredWorkflowLaneResults(artifacts), []);
    assert.deepEqual(settlement.completedLanes, new Set(["image:0"]));
    assert.deepEqual(settlement.failedLanes, new Set());
    assert.equal(settlement.settled, true);
  });

  test("later error attempt supersedes stale successful completion", () => {
    const artifacts: WorkflowRunArtifacts = {
      laneResults: [success(output("image", 0)), errorResult("image", 0, 1)],
    };
    const settlement = getWorkflowLaneSettlement({
      artifacts,
      plan: { jobs: [{ dependencies: [], laneIndex: 0, nodeId: "image" }] },
    });

    assert.deepEqual(getSuccessfulWorkflowLaneOutputs(artifacts), []);
    assert.deepEqual(settlement.completedLanes, new Set());
    assert.deepEqual(settlement.failedLanes, new Set(["image:0"]));
    assert.equal(settlement.settled, true);
  });
});
