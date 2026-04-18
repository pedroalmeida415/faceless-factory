"use client";

import { ManagedRuntime } from "effect";
import { WorkflowStudioStoreService } from "~/components/workflow/studio/runner/store-service";

export const ClientRuntime = ManagedRuntime.make(
	WorkflowStudioStoreService.Live,
);
