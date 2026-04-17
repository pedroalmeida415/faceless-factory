import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";

import {
	guessMimeType,
	resolveAssetAbsolutePath,
} from "~/lib/workflow/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
	_request: Request,
	context: { params: Promise<{ slug: string[] }> },
) {
	try {
		const { slug } = await context.params;
		const relativePath = slug.join("/");
		const absolutePath = resolveAssetAbsolutePath(relativePath);
		const data = await readFile(absolutePath);
		const mimeType = guessMimeType(relativePath);
		return new NextResponse(data, {
			headers: {
				"Content-Type": mimeType,
				"Cache-Control": "public, max-age=31536000, immutable",
			},
		});
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Unable to read asset.";
		return NextResponse.json({ error: message }, { status: 404 });
	}
}
