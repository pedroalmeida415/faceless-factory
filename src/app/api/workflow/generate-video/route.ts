import { NextResponse } from "next/server";
import type { GenerateVideoRequest } from "~/lib/workflow/types";
import { generateVideosWithVeo31 } from "~/lib/workflow/vertex";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 420;

export async function POST(request: Request) {
	try {
		const body = (await request.json()) as GenerateVideoRequest;
		const result = await generateVideosWithVeo31(body);
		return NextResponse.json(result);
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Video generation failed.";
		return NextResponse.json({ error: message }, { status: 500 });
	}
}
