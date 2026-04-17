import {
	GoogleGenAI,
	Modality,
	VideoGenerationReferenceType,
} from "@google/genai";
import {
	createExternalAsset,
	readStoredAsset,
	saveBufferAsAsset,
} from "~/lib/workflow/storage";
import {
	type GenerateImageRequest,
	type GenerateVideoRequest,
	NANO_BANANA_PRO_MODEL_ID,
	VEO_31_MODEL_ID,
	type WorkflowAsset,
} from "~/lib/workflow/types";

function readServiceAccountCredentials() {
	if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
		const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON) as {
			client_email?: string;
			private_key?: string;
			project_id?: string;
		};
		return {
			clientEmail: parsed.client_email,
			privateKey: parsed.private_key,
			projectId: parsed.project_id,
		};
	}

	return {
		clientEmail: process.env.GOOGLE_CLIENT_EMAIL,
		privateKey: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
		projectId: undefined,
	};
}

function getGoogleProjectId() {
	const credentials = readServiceAccountCredentials();
	return process.env.GOOGLE_CLOUD_PROJECT ?? credentials.projectId ?? null;
}

function getGoogleAuthOptions() {
	const credentials = readServiceAccountCredentials();
	if (!credentials.clientEmail || !credentials.privateKey) {
		return undefined;
	}

	return {
		credentials: {
			client_email: credentials.clientEmail,
			private_key: credentials.privateKey,
		},
	};
}

function createVertexClient(location: string) {
	const projectId = getGoogleProjectId();
	if (!projectId) {
		throw new Error(
			"Missing Vertex AI config. Set GOOGLE_CLOUD_PROJECT and either ADC or service account credentials.",
		);
	}

	return new GoogleGenAI({
		vertexai: true,
		project: projectId,
		location,
		googleAuthOptions: getGoogleAuthOptions(),
	});
}

function getImageLocation() {
	return process.env.GOOGLE_CLOUD_LOCATION_IMAGE ?? "global";
}

function getVideoLocation() {
	const sharedLocation = process.env.GOOGLE_CLOUD_LOCATION;
	if (process.env.GOOGLE_CLOUD_LOCATION_VIDEO) {
		return process.env.GOOGLE_CLOUD_LOCATION_VIDEO;
	}
	if (sharedLocation && sharedLocation !== "global") {
		return sharedLocation;
	}
	return "us-central1";
}

async function toInlineImagePart(asset: WorkflowAsset) {
	const buffer = await readStoredAsset(asset);
	return {
		inlineData: {
			data: buffer.toString("base64"),
			mimeType: asset.mimeType,
		},
	};
}

async function toSdkImage(asset: WorkflowAsset) {
	const buffer = await readStoredAsset(asset);
	return {
		imageBytes: buffer.toString("base64"),
		mimeType: asset.mimeType,
	};
}

async function toVideoReferenceImage(asset: WorkflowAsset) {
	return {
		image: await toSdkImage(asset),
		referenceType: VideoGenerationReferenceType.ASSET,
	};
}

function pickImageParts(
	response: Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>,
) {
	return (
		response.candidates
			?.flatMap((candidate) => candidate.content?.parts ?? [])
			.filter((part) => Boolean(part.inlineData?.data)) ?? []
	);
}

export async function generateImagesWithNanoBananaPro({
	prompt,
	referenceImages = [],
	aspectRatio = "1:1",
}: GenerateImageRequest) {
	const client = createVertexClient(getImageLocation());
	const promptText = prompt.trim();

	if (!promptText) {
		throw new Error("Prompt is required for image generation.");
	}

	const imageParts = await Promise.all(
		referenceImages.map((asset) => toInlineImagePart(asset)),
	);
	const response = await client.models.generateContent({
		model: NANO_BANANA_PRO_MODEL_ID,
		contents: [
			{
				role: "user",
				parts: [{ text: promptText }, ...imageParts],
			},
		],
		config: {
			responseModalities: [Modality.TEXT, Modality.IMAGE],
			imageConfig: {
				aspectRatio,
				outputMimeType: "image/png",
			},
		},
	});

	const generatedParts = pickImageParts(response);
	if (!generatedParts.length) {
		throw new Error(response.text || "Vertex AI returned no image output.");
	}

	const assets = await Promise.all(
		generatedParts.map(async (part, index) => {
			const mimeType = part.inlineData?.mimeType ?? "image/png";
			const bytes = part.inlineData?.data;

			if (!bytes) {
				throw new Error("Missing image bytes in Vertex AI response.");
			}

			return saveBufferAsAsset({
				buffer: Buffer.from(bytes, "base64"),
				kind: "image",
				source: "generated",
				mimeType,
				fileName: `nano-banana-pro-${index + 1}.png`,
				model: NANO_BANANA_PRO_MODEL_ID,
			});
		}),
	);

	return {
		assets,
		responseText: response.text || null,
		model: NANO_BANANA_PRO_MODEL_ID,
	};
}

export async function generateVideosWithVeo31({
	prompt,
	referenceImage = null,
	referenceImages = [],
	aspectRatio = "16:9",
	durationSeconds = 4,
	generateAudio = true,
	resolution = "720p",
}: GenerateVideoRequest) {
	const client = createVertexClient(getVideoLocation());
	const promptText = prompt.trim();
	const inputImages =
		referenceImages.length > 0
			? referenceImages
			: referenceImage
				? [referenceImage]
				: [];

	if (!promptText && !inputImages.length) {
		throw new Error(
			"Prompt or reference image is required for video generation.",
		);
	}

	if (inputImages.length > 1 && !promptText) {
		throw new Error(
			"Prompt is required when using multiple reference images for video generation.",
		);
	}

	let operation = await client.models.generateVideos({
		model: VEO_31_MODEL_ID,
		source: {
			prompt: promptText || undefined,
			image:
				inputImages.length === 1
					? await toSdkImage(inputImages[0] as WorkflowAsset)
					: undefined,
		},
		config: {
			numberOfVideos: 1,
			durationSeconds,
			aspectRatio,
			generateAudio,
			resolution,
			personGeneration: "allow_adult",
			referenceImages:
				inputImages.length > 1
					? await Promise.all(
							inputImages.map((asset) => toVideoReferenceImage(asset)),
						)
					: undefined,
		},
	});

	const timeoutAt = Date.now() + 6 * 60 * 1000;
	while (!operation.done) {
		if (Date.now() > timeoutAt) {
			throw new Error("Veo generation timed out after 6 minutes.");
		}
		await new Promise((resolve) => setTimeout(resolve, 10000));
		operation = await client.operations.getVideosOperation({ operation });
	}

	if (operation.error) {
		throw new Error(JSON.stringify(operation.error));
	}

	const generatedVideos = operation.response?.generatedVideos ?? [];
	if (!generatedVideos.length) {
		throw new Error("Vertex AI returned no video output.");
	}

	const assets = await Promise.all(
		generatedVideos.map(async (generatedVideo, index) => {
			const video = generatedVideo.video;
			const mimeType = video?.mimeType ?? "video/mp4";

			if (video?.videoBytes) {
				return saveBufferAsAsset({
					buffer: Buffer.from(video.videoBytes, "base64"),
					kind: "video",
					source: "generated",
					mimeType,
					fileName: `veo-3-1-${index + 1}.mp4`,
					model: VEO_31_MODEL_ID,
				});
			}

			if (video?.uri) {
				return createExternalAsset({
					kind: "video",
					source: "generated",
					mimeType,
					fileName: `veo-3-1-${index + 1}.mp4`,
					url: video.uri,
					model: VEO_31_MODEL_ID,
				});
			}

			throw new Error(
				"Vertex AI did not return playable video bytes or a URI.",
			);
		}),
	);

	return {
		assets,
		model: VEO_31_MODEL_ID,
	};
}
