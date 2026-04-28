// @ts-nocheck

import { describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { Context, Effect, Layer } from "effect";

mock.module("~/server/workflow/artifact-store", () => {
  class WorkflowArtifactStore extends Context.Tag("WorkflowArtifactStore")() {}
  return {
    WorkflowArtifactStore,
    buildLaneExecutionResultFromDocument: () => ({
      costCredits: 0,
      laneIndex: null,
      outputs: [],
      runId: "run",
      status: "success",
    }),
  };
});

mock.module("~/server/workflow/credits", () => {
  class WorkflowCreditsService extends Context.Tag(
    "WorkflowCreditsService",
  )() {}
  return { WorkflowCreditsService };
});

mock.module("~/server/workflow/project-store", () => {
  class WorkflowProjectStore extends Context.Tag("WorkflowProjectStore")() {}
  return { WorkflowProjectStore };
});

mock.module("~/server/workflow/run-store", () => {
  class WorkflowRunStore extends Context.Tag("WorkflowRunStore")() {}
  return { WorkflowRunStore };
});

mock.module("~/server/workflow/vertex", () => {
  class VertexAi extends Context.Tag("VertexAi")() {}
  return { VertexAi };
});

const enqueuedJobs = [];
mock.module("~/server/workflow/queue", () => ({
  createWorkflowExecutionLaneJobId: ({ laneIndex, nodeId, runId }) =>
    `${runId}:${nodeId}:${laneIndex}`,
  createWorkflowReviewRegenerationJobId: () => "review-job",
  enqueueWorkflowExecutionJob: (job, options) => {
    enqueuedJobs.push({ job, options });
    return Promise.resolve();
  },
  enqueueWorkflowReviewRegenerationJob: () => Promise.resolve(),
  getWorkflowExecutionQueue: () => ({ getJobs: () => Promise.resolve([]) }),
}));

const {
  createWorkflowNode,
  toWorkflowGraphDocument,
  WORKFLOW_DOCUMENT_VERSION,
} = await import("~/lib/workflow/document");
const { LLM_ESTIMATED_CREDIT_COST } = await import("~/lib/workflow/llm-models");
const { WorkflowExecutionService } = await import(
  "~/server/workflow/execution-service"
);
const { WorkflowArtifactStore } = await import(
  "~/server/workflow/artifact-store"
);
const { WorkflowCreditsService } = await import("~/server/workflow/credits");
const { WorkflowProjectStore } = await import(
  "~/server/workflow/project-store"
);
const { WorkflowRunStore } = await import("~/server/workflow/run-store");
const { VertexAi } = await import("~/server/workflow/vertex");

function workflowDocument() {
  const list = {
    ...createWorkflowNode("list", 0),
    id: "list",
    items: ["one", "two", "three"],
  };
  const prompt = {
    ...createWorkflowNode("prompt", 1),
    id: "prompt",
    prompt: "{{variable1}}",
    variables: [{ key: "variable1", label: "Variable 1" }],
  };
  const llm = { ...createWorkflowNode("llmGenerator", 2), id: "llm" };
  return {
    edges: [
      {
        id: "list-prompt",
        source: "list",
        sourceHandle: "text",
        target: "prompt",
        targetHandle: "variable1",
      },
      {
        id: "prompt-llm",
        source: "prompt",
        sourceHandle: "text",
        target: "llm",
        targetHandle: "prompt",
      },
    ],
    nodes: [list, prompt, llm],
    version: WORKFLOW_DOCUMENT_VERSION,
  };
}

function success(laneIndex, runId, updatedAt) {
  return {
    attempt: 0,
    documentRevision: 1,
    idempotencyKey: `${runId}:${laneIndex}`,
    inputHash: `${runId}:ignored-input-${laneIndex}`,
    laneIndex,
    model: "ignored-model",
    nodeId: "llm",
    ownerUserId: "user",
    projectId: "project",
    promptSnapshot: "ignored prompt",
    reviewStatus: null,
    runId,
    status: "success",
    updatedAt,
    value: { lanes: [`output-${laneIndex}`], type: "text" },
  };
}

function laneError(laneIndex, runId, updatedAt) {
  return {
    attempt: 0,
    error: "failed",
    failedAt: updatedAt,
    laneIndex,
    nodeId: "llm",
    ownerUserId: "user",
    projectId: "project",
    runId,
    status: "error",
    updatedAt,
  };
}

describe("WorkflowExecutionService startRun lane recovery", () => {
  test("starts a new run, reuses only latest successful lanes, quotes and queues only missing lanes", async () => {
    enqueuedJobs.length = 0;
    const oldFailedRunId = "old-failed-run";
    const oldLaneError = laneError(
      1,
      oldFailedRunId,
      "2026-01-03T00:00:00.000Z",
    );
    const priorResults = [
      success(0, oldFailedRunId, "2026-01-01T00:00:00.000Z"),
      success(1, "older-success", "2026-01-01T00:00:00.000Z"),
      oldLaneError,
      success(2, "old-success-run", "2026-01-02T00:00:00.000Z"),
    ];
    const copiedOutputs = [];
    const createdRuns = [];
    const debits = [];
    const document = workflowDocument();

    const TestLayer = WorkflowExecutionService.Live.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(WorkflowProjectStore, {
            getProject: () =>
              Effect.succeed({
                document: toWorkflowGraphDocument(document),
                documentRevision: 1,
                id: "project",
                name: "Project",
              }),
          }),
          Layer.succeed(WorkflowArtifactStore, {
            copyReusableLaneOutputs: ({ outputs }) => {
              copiedOutputs.push(...outputs);
              return Effect.succeed(outputs.length);
            },
            getProjectLaneReuseCandidates: () => Effect.succeed(priorResults),
            getRunArtifacts: () =>
              Effect.succeed({
                laneResults: copiedOutputs.map((output) => ({
                  ...output,
                  status: "success",
                })),
              }),
          }),
          Layer.succeed(WorkflowCreditsService, {
            debitExecution: (params) => {
              debits.push(params);
              return Effect.succeed({
                available: 1000,
                reserved: params.amount,
                totalCost: params.amount,
                used: 0,
              });
            },
            refundExecution: () =>
              Effect.succeed({
                available: 1000,
                reserved: 0,
                totalCost: 0,
                used: 0,
              }),
          }),
          Layer.succeed(WorkflowRunStore, {
            createRun: ({ run }) => {
              createdRuns.push(run);
              return Effect.succeed(run);
            },
            updateRun: (run) => Effect.succeed(run),
          }),
          Layer.succeed(VertexAi, {}),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkflowExecutionService;
        return yield* service.startRun("user", {
          document,
          documentRevision: 1,
          projectId: "project",
          target: { type: "node", nodeId: "llm" },
        });
      }).pipe(Effect.provide(TestLayer)),
    );

    assert.notEqual(result.runId, oldFailedRunId);
    assert.equal(oldLaneError.status, "error");
    assert.deepEqual(
      copiedOutputs.map((output) => output.laneIndex),
      [0, 2],
    );
    assert.equal(debits[0].amount, LLM_ESTIMATED_CREDIT_COST);
    assert.deepEqual(
      enqueuedJobs.map(({ job }) => job.request.executionLaneFilter.laneIndex),
      [1],
    );
    assert.deepEqual(
      enqueuedJobs.map(({ job }) => job.request.selection.nodeIds),
      [["llm"]],
    );
    assert.equal(createdRuns[0].status, "queued");
  });
});
