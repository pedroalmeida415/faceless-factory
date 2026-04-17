import { NextResponse } from "next/server";
import type { GenerateImageRequest } from "~/lib/workflow/types";
import { generateImagesWithNanoBananaPro } from "~/lib/workflow/vertex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
	try {
		const body = (await request.json()) as GenerateImageRequest;
		const result = await generateImagesWithNanoBananaPro(body);
		return NextResponse.json(result);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Image generation failed.";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
