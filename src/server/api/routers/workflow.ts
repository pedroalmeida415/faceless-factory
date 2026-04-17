import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { saveFormFileAsAsset } from "~/lib/workflow/storage";
import {
	IMAGE_ASPECT_RATIOS,
	VIDEO_ASPECT_RATIOS,
	VIDEO_DURATIONS,
	VIDEO_RESOLUTIONS,
} from "~/lib/workflow/types";
import {
	generateImagesWithNanoBananaPro,
	generateVideosWithVeo31,
} from "~/lib/workflow/vertex";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";

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
		.mutation(({ input }) => generateImagesWithNanoBananaPro(input)),

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
		.mutation(({ input }) => generateVideosWithVeo31(input)),

	uploadAsset: publicProcedure
		.input(formDataSchema)
		.mutation(async ({ input }) => {
			const file = input.get("file");

			if (!(file instanceof File)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Missing file upload.",
				});
			}

			const kind = file.type.startsWith("image/")
				? "image"
				: file.type.startsWith("video/")
					? "video"
					: null;

			if (!kind) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Only image and video uploads are supported.",
				});
			}

			const asset = await saveFormFileAsAsset({
				file,
				kind,
				source: "upload",
			});

			return { asset };
		}),
});
