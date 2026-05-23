import { z } from "zod";

export const WorkflowConfigValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const WorkflowConfigSchema = z.record(z.string(), WorkflowConfigValueSchema);

export const WorkflowDataTypeSchema = z.enum(["text", "image", "video", "audio"]);
export const WorkflowGenerationKindSchema = z.enum(["image", "video"]);

export const WorkflowModelInputSocketSchema = z.object({
  capacity: z.number().int().min(1),
  dataType: WorkflowDataTypeSchema,
  id: z.string().min(1),
  label: z.string().min(1),
  repeatable: z.boolean(),
  required: z.boolean(),
});

export const WorkflowModelConfigFieldSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("select"),
    label: z.string().min(1),
    options: z.array(
      z.object({
        label: z.string().min(1),
        value: z.string().min(1),
      }),
    ),
  }),
]);

export const WorkflowModelDefinitionSchema = z.object({
  configFields: z.array(WorkflowModelConfigFieldSchema),
  costPerBatchItemCredits: z.number().int().nonnegative(),
  defaultConfig: WorkflowConfigSchema,
  displayName: z.string().min(1),
  generationKind: WorkflowGenerationKindSchema,
  inputSockets: z.array(WorkflowModelInputSocketSchema),
  maxBranchBatchSize: z.number().int().min(1),
  modelId: z.string().min(1),
});

export type WorkflowDataType = z.infer<typeof WorkflowDataTypeSchema>;
export type WorkflowModelDefinition = z.infer<typeof WorkflowModelDefinitionSchema>;
export type WorkflowModelInputSocket = z.infer<typeof WorkflowModelInputSocketSchema>;

export const NANO_BANANA_PRO_MODEL = {
  configFields: [
    {
      id: "resolution",
      kind: "select",
      label: "Resolution",
      options: [
        { label: "720p", value: "720p" },
        { label: "1080p", value: "1080p" },
      ],
    },
  ],
  costPerBatchItemCredits: 1,
  defaultConfig: { resolution: "1080p" },
  displayName: "Nano Banana Pro",
  generationKind: "image",
  inputSockets: [
    {
      capacity: 1,
      dataType: "text",
      id: "prompt",
      label: "Prompt",
      repeatable: false,
      required: true,
    },
    {
      capacity: 3,
      dataType: "image",
      id: "image",
      label: "Image",
      repeatable: true,
      required: false,
    },
  ],
  maxBranchBatchSize: 4,
  modelId: "nano-banana-pro",
} satisfies WorkflowModelDefinition;

export const WORKFLOW_MODEL_CATALOG = [NANO_BANANA_PRO_MODEL] satisfies readonly WorkflowModelDefinition[];
