import { Effect } from "effect";
import { z } from "zod";

import { ServerRuntime } from "~/effect/server/runtime";
import { WorkflowValidationError } from "~/lib/workflow/errors";
import {
	IMAGE_ASPECT_RATIOS,
	VIDEO_ASPECT_RATIOS,
	VIDEO_DURATIONS,
	VIDEO_RESOLUTIONS,
} from "~/lib/workflow/types";
import { toTRPCError } from "~/server/api/errors";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { WorkflowStorage } from "~/server/workflow/storage";
import { VertexAi } from "~/server/workflow/vertex";

const workflowAssetSchema = z.object({
	id: z.string(),
	kind: z.enum(["image", "video"]),
	source: z.enum(["upload", "generated"]),
	fileName: z.string(),
	mimeType: z.string(),
	size: z.number(),
	createdAt: z.string(),
	url: z.string(),
	storagePath: z.string().nullable(),
	externalUri: z.string().nullable(),
	model: z.string().nullable(),
});

const formDataSchema = z.custom<FormData>(
	(value) => value instanceof FormData,
	"Expected FormData input.",
);

const videoDurationSchema = z.custom<(typeof VIDEO_DURATIONS)[number]>(
	(value) =>
		typeof value === "number" &&
		VIDEO_DURATIONS.includes(value as (typeof VIDEO_DURATIONS)[number]),
	"Invalid video duration.",
);

export const workflowRouter = createTRPCRouter({
	generateImage: publicProcedure
		.input(
			z.object({
				prompt: z.string(),
				referenceImages: z.array(workflowAssetSchema).optional(),
				aspectRatio: z.enum(IMAGE_ASPECT_RATIOS).optional(),
			}),
		)
		.mutation(async ({ input }) =>
			ServerRuntime.runPromise(
				Effect.gen(function* () {
					const vertexAi = yield* VertexAi;
					return yield* vertexAi.generateImagesWithNanoBananaPro(input);
				}),
			).catch((error) => {
				throw toTRPCError(error);
			}),
		),

	generateVideo: publicProcedure
		.input(
			z.object({
				prompt: z.string(),
				referenceImage: workflowAssetSchema.nullable().optional(),
				referenceImages: z.array(workflowAssetSchema).optional(),
				aspectRatio: z.enum(VIDEO_ASPECT_RATIOS).optional(),
				durationSeconds: videoDurationSchema.optional(),
				generateAudio: z.boolean().optional(),
				resolution: z.enum(VIDEO_RESOLUTIONS).optional(),
			}),
		)
		.mutation(async ({ input }) =>
			ServerRuntime.runPromise(
				Effect.gen(function* () {
					const vertexAi = yield* VertexAi;
					return yield* vertexAi.generateVideosWithVeo31(input);
				}),
			).catch((error) => {
				throw toTRPCError(error);
			}),
		),

	uploadAsset: publicProcedure
		.input(formDataSchema)
		.mutation(async ({ input }) =>
			ServerRuntime.runPromise(
				Effect.gen(function* () {
					const workflowStorage = yield* WorkflowStorage;
					const file = input.get("file");

					if (!(file instanceof File)) {
						return yield* Effect.fail(
							new WorkflowValidationError({ message: "Missing file upload." }),
						);
					}

					const kind = file.type.startsWith("image/")
						? "image"
						: file.type.startsWith("video/")
							? "video"
							: null;

					if (!kind) {
						return yield* Effect.fail(
							new WorkflowValidationError({
								message: "Only image and video uploads are supported.",
							}),
						);
					}

					const asset = yield* workflowStorage.saveFormFileAsAsset({
						file,
						kind,
						source: "upload",
					});

					return { asset };
				}),
			).catch((error) => {
				throw toTRPCError(error);
			}),
		),
});
