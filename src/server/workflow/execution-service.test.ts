// @ts-nocheck

import { describe, mock, test } from "bun:test";
import assert from "node:assert/strict";
import { Context, Effect, Layer } from "effect";

mock.module("~/server/workflow/artifact-store", () => {
  class WorkflowArtifactStore extends Context.Tag("WorkflowArtifactStore")() {}
  return {
    WorkflowArtifactStore,
    buildOutputExecutionResultFromDocument: () => ({
      costCredits: 0,
      outputIndex: null,
      outputs: [],
      executionId: "run",
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

mock.module("~/server/workflow/execution-store", () => {
  class WorkflowExecutionStore extends Context.Tag(
    "WorkflowExecutionStore",
  )() {}
  return { WorkflowExecutionStore };
});

mock.module("~/server/workflow/vertex", () => {
  class VertexAi extends Context.Tag("VertexAi")() {}
  return { VertexAi };
});

const enqueuedJobs = [];
mock.module("~/server/workflow/queue", () => ({
  enqueueWorkflowTaskRunJob: (job) => {
    enqueuedJobs.push({ job, options: { jobId: job.taskRunId } });
    return Promise.resolve();
  },
  getWorkflowExecutionQueue: () => ({ getJobs: () => Promise.resolve([]) }),
}));

mock.module("~/server/workflow/task-queue-scanner", () => ({
  enqueueQueuedWorkflowTasks: ({ taskRunIds }) => {
    for (const taskRunId of taskRunIds ?? []) {
      enqueuedJobs.push({ job: { taskRunId }, options: { jobId: taskRunId } });
    }
    return Effect.succeed(taskRunIds?.length ?? 0);
  },
}));

mock.module("~/server/workflow/task-run-store", () => ({
  claimQueuedWorkflowTaskRun: () =>
    Effect.succeed({ claimed: false, row: null }),
  createQueuedWorkflowTaskRuns: ({ executionId, jobs, ownerUserId }) =>
    Effect.succeed(
      jobs.map((job) => ({
        executionId,
        jobId: `${executionId}:${job.nodeId}:${job.outputIndex}`,
        taskRunId: `${executionId}:${job.nodeId}:${job.outputIndex}`,
        userId: ownerUserId,
      })),
    ),
  getTaskRunExecutionDocumentSnapshot: () => null,
  getTaskRunSnapshotOutputValue: () => null,
  toTaskRunExecutionRequest: (snapshot) => snapshot,
}));

const {
  createWorkflowNode,
  toWorkflowGraphDocument,
  WORKFLOW_DOCUMENT_VERSION,
} = await import("~/lib/workflow/document");
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
const { WorkflowExecutionStore } = await import(
  "~/server/workflow/execution-store"
);
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

function success(outputIndex, executionId, updatedAt) {
  return {
    attempt: 0,
    documentRevision: 1,
    idempotencyKey: `${executionId}:${outputIndex}`,
    inputHash: `${executionId}:ignored-input-${outputIndex}`,
    outputIndex,
    model: "ignored-model",
    nodeId: "llm",
    ownerUserId: "user",
    projectId: "project",
    promptSnapshot: "ignored prompt",
    reviewStatus: null,
    executionId,
    status: "success",
    updatedAt,
    value: { items: [`output-${outputIndex}`], type: "text" },
  };
}

function outputError(outputIndex, executionId, updatedAt) {
  return {
    attempt: 0,
    error: "failed",
    failedAt: updatedAt,
    outputIndex,
    nodeId: "llm",
    ownerUserId: "user",
    projectId: "project",
    executionId,
    status: "error",
    updatedAt,
  };
}

describe("WorkflowExecutionService quoteExecution", () => {
  test("quotes generator targets before upstream inputs are runnable", async () => {
    const list = { ...createWorkflowNode("list", 0), id: "list", items: [] };
    const prompt = {
      ...createWorkflowNode("prompt", 1),
      id: "prompt",
      prompt: "{{variable1}}",
      variables: [{ key: "variable1", label: "Variable 1" }],
    };
    const image = {
      ...createWorkflowNode("imageGenerator", 2),
      id: "image",
    };
    const document = {
      edges: [
        {
          id: "list-prompt",
          source: "list",
          sourceHandle: "text",
          target: "prompt",
          targetHandle: "variable1",
        },
        {
          id: "prompt-image",
          source: "prompt",
          sourceHandle: "text",
          target: "image",
          targetHandle: "prompt",
        },
      ],
      nodes: [list, prompt, image],
      version: WORKFLOW_DOCUMENT_VERSION,
    };

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
            getProjectOutputReuseCandidates: () => Effect.succeed([]),
          }),
          Layer.succeed(WorkflowCreditsService, {}),
          Layer.succeed(WorkflowExecutionStore, {}),
          Layer.succeed(VertexAi, {}),
        ),
      ),
    );

    const quote = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkflowExecutionService;
        return yield* service.quoteExecution("user", {
          documentRevision: 1,
          projectId: "project",
          target: { type: "node", nodeId: "image" },
        });
      }).pipe(Effect.provide(TestLayer)),
    );

    assert.deepEqual(
      quote.lineItems.map((lineItem) => [lineItem.nodeId, lineItem.kind]),
      [["image", "imageGenerator"]],
    );
    assert.equal(quote.totalCost > 0, true);
  });
});

describe("WorkflowExecutionService startExecution output recovery", () => {
  test("starts a normal run without copying successful requested target outputs", async () => {
    enqueuedJobs.length = 0;
    const priorResults = [
      success(0, "old-success-run", "2026-01-01T00:00:00.000Z"),
      success(1, "old-success-run", "2026-01-02T00:00:00.000Z"),
      success(2, "old-success-run", "2026-01-03T00:00:00.000Z"),
    ];
    const copiedOutputs = [];
    const outputDebits = [];
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
            copyReusableOutputs: ({ outputs }) => {
              copiedOutputs.push(...outputs);
              return Effect.succeed(outputs.length);
            },
            getActiveOutputKeys: () => Effect.succeed([]),
            getProjectOutputReuseCandidates: () => Effect.succeed(priorResults),
            getOutputArtifacts: () =>
              Effect.succeed({
                outputResults: copiedOutputs.map((output) => ({
                  ...output,
                  status: "success",
                })),
              }),
          }),
          Layer.succeed(WorkflowCreditsService, {
            debitExecutionOutput: (params) => {
              outputDebits.push(params);
              return Effect.succeed({
                available: 1000,
                reserved: 0,
                totalCost: params.amount,
                used: params.amount,
              });
            },
            getBalanceSummary: () =>
              Effect.succeed({
                available: 1000,
                reserved: 0,
                totalCost: 0,
                used: 0,
              }),
            getExecutionSummary: () =>
              Effect.succeed({
                available: 1000,
                reserved: 0,
                totalCost: 0,
                used: 0,
              }),
          }),
          Layer.succeed(WorkflowExecutionStore, {
            createExecution: ({ run }) => Effect.succeed(run),
            updateExecution: (run) => Effect.succeed(run),
          }),
          Layer.succeed(VertexAi, {}),
        ),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkflowExecutionService;
        return yield* service.startExecution("user", {
          document,
          documentRevision: 1,
          projectId: "project",
          target: { type: "node", nodeId: "llm" },
        });
      }).pipe(Effect.provide(TestLayer)),
    );

    assert.deepEqual(copiedOutputs, []);
    assert.equal(outputDebits.length, 0);
    assert.deepEqual(
      enqueuedJobs.map(({ job }) => job.taskRunId.split(":").slice(1)),
      [
        ["llm", "0"],
        ["llm", "1"],
        ["llm", "2"],
      ],
    );
  });

  test("starts a new run without upfront debit and queues only missing outputs", async () => {
    enqueuedJobs.length = 0;
    const oldFailedExecutionId = "old-failed-run";
    const oldOutputError = outputError(
      1,
      oldFailedExecutionId,
      "2026-01-03T00:00:00.000Z",
    );
    const priorResults = [
      success(0, oldFailedExecutionId, "2026-01-01T00:00:00.000Z"),
      success(1, "older-success", "2026-01-01T00:00:00.000Z"),
      oldOutputError,
      success(2, "old-success-run", "2026-01-02T00:00:00.000Z"),
    ];
    const copiedOutputs = [];
    const createdRuns = [];
    const outputDebits = [];
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
            copyReusableOutputs: ({ outputs }) => {
              copiedOutputs.push(...outputs);
              return Effect.succeed(outputs.length);
            },
            getActiveOutputKeys: () => Effect.succeed([]),
            getProjectOutputReuseCandidates: () => Effect.succeed(priorResults),
            getOutputArtifacts: () =>
              Effect.succeed({
                outputResults: copiedOutputs.map((output) => ({
                  ...output,
                  status: "success",
                })),
              }),
          }),
          Layer.succeed(WorkflowCreditsService, {
            debitExecutionOutput: (params) => {
              outputDebits.push(params);
              return Effect.succeed({
                available: 1000,
                reserved: 0,
                totalCost: params.amount,
                used: params.amount,
              });
            },
            getBalanceSummary: () =>
              Effect.succeed({
                available: 1000,
                reserved: 0,
                totalCost: 0,
                used: 0,
              }),
            getExecutionSummary: () =>
              Effect.succeed({
                available: 1000,
                reserved: 0,
                totalCost: 0,
                used: 0,
              }),
          }),
          Layer.succeed(WorkflowExecutionStore, {
            createExecution: ({ run }) => {
              createdRuns.push(run);
              return Effect.succeed(run);
            },
            updateExecution: (run) => Effect.succeed(run),
          }),
          Layer.succeed(VertexAi, {}),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* WorkflowExecutionService;
        return yield* service.startExecution("user", {
          document,
          documentRevision: 1,
          projectId: "project",
          target: { type: "node", nodeId: "llm" },
        });
      }).pipe(Effect.provide(TestLayer)),
    );

    assert.notEqual(result.executionId, oldFailedExecutionId);
    assert.equal(oldOutputError.status, "error");
    assert.deepEqual(
      copiedOutputs.map((output) => output.outputIndex),
      [0, 2],
    );
    assert.equal(outputDebits.length, 0);
    assert.deepEqual(
      enqueuedJobs.map(({ job }) => job.taskRunId.split(":").slice(1)),
      [["llm", "1"]],
    );
    assert.equal(createdRuns[0].status, "queued");
  });
});
