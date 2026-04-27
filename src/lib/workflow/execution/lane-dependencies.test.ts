import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  createWorkflowNode,
  WORKFLOW_DOCUMENT_VERSION,
  type WorkflowDocument,
  type WorkflowDocumentNode,
} from "~/lib/workflow/document";
import { getWorkflowVisibleCompletionOutputs } from "~/lib/workflow/execution/artifact-projection";
import {
  buildWorkflowLaneDependencyPlan,
  getReadyWorkflowLaneJobs,
  getWorkflowLaneKey,
} from "~/lib/workflow/execution/lane-dependencies";
import type {
  NodeLaneOutputArtifact,
  WorkflowRunArtifacts,
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

function output(nodeId: string, laneIndex: number): NodeLaneOutputArtifact {
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
    runId: "run",
    value: { lanes: [`${nodeId}:${laneIndex}`], type: "text" },
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
    artifacts.outputs
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
      lineage: [],
      outputs: [output("reviewed", 0)],
      reviewLanes: [
        {
          attempt: 0,
          laneIndex: 0,
          nodeId: "reviewed",
          ownerUserId: "user",
          projectId: "project",
          runId: "run",
          status: "pending",
          valueType: "text",
        },
      ],
    };

    const [reviewLane] = artifacts.reviewLanes;
    assert.deepEqual(getWorkflowVisibleCompletionOutputs(artifacts), []);
    assert.deepEqual(
      getWorkflowVisibleCompletionOutputs({
        ...artifacts,
        reviewLanes: reviewLane ? [{ ...reviewLane, status: "approved" }] : [],
      }),
      artifacts.outputs,
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
      lineage: [],
      outputs: [output(image.id, 0), output(image.id, 1)],
      reviewLanes: [
        {
          attempt: 0,
          laneIndex: 0,
          nodeId: image.id,
          ownerUserId: "user",
          projectId: "project",
          runId: "run",
          status: "approved",
          valueType: "image",
        },
        {
          attempt: 0,
          laneIndex: 1,
          nodeId: image.id,
          ownerUserId: "user",
          projectId: "project",
          runId: "run",
          status: "pending",
          valueType: "image",
        },
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
          ...artifacts,
          reviewLanes: artifacts.reviewLanes.map((lane) => ({
            ...lane,
            status: "approved" as const,
          })),
        }),
        completedLanes: visibleLaneKeys({
          ...artifacts,
          reviewLanes: artifacts.reviewLanes.map((lane) => ({
            ...lane,
            status: "approved" as const,
          })),
        }),
        plan,
      }).some((job) => job.nodeId === video.id && job.laneIndex === 0),
      true,
    );
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
});
