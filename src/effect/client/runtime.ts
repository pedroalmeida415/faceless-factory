"use client";

import { ManagedRuntime } from "effect";
import { WorkflowStudioStoreService } from "~/lib/workflow/services/workflow-studio-store-service";

export const ClientRuntime = ManagedRuntime.make(
  WorkflowStudioStoreService.Live,
);
