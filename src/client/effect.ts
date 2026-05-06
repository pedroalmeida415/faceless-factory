"use client";

import { ManagedRuntime } from "effect";
import { WorkflowStudioStoreService } from "~/features/workflow/client/workflow-studio-store-service";

export const ClientRuntime = ManagedRuntime.make(
  WorkflowStudioStoreService.Live,
);
