"use client";

import { WorkflowAssetService } from "~/lib/workflow/services/workflow-asset-service";
import { WorkflowExecutionService } from "~/lib/workflow/services/workflow-execution-service";

export const uploadFilesToNode = WorkflowAssetService.uploadFilesToNode;

export const runNode = (nodeId: string) =>
  WorkflowExecutionService.run({ type: "node", nodeId });

export const runSelectedOrAll = () =>
  WorkflowExecutionService.run({ type: "selected-or-all" });
